/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/runs.cpp
 * @brief Run management and reporting routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/metrics_helper.hpp"

#include <algorithm>
#include <chrono>
#include <thread>
#include <utility>

namespace vayu::http::routes {

namespace {

// How long DELETE /runs/:id waits for an active run's worker to settle before
// refusing the delete. Matches the 5s POST /runs/:id/stop already waits for a
// graceful stop, so a client that stops and then deletes sees one budget, not
// two different ones.
constexpr int64_t DELETE_STOP_WAIT_MS = 5000;

// Copy src[key] to dst[key] when present and not null. Shared by the list-row
// `summary` builder and the report route's `config_obj` (which adds a few
// renamed keys on top) so the two extract config fields the same way.
void add_if_present (nlohmann::json& dst, const nlohmann::json& src, const char* key) {
    if (src.contains (key) && !src[key].is_null ())
        dst[key] = src[key];
}

// httpVersion is handled separately from add_if_present, and always ends up
// present: a raw POST /runs body of `"httpVersion": null` (a request for no
// explicit protocol) lands in config_snapshot verbatim, because config_snapshot is
// built from the raw request body *before* normalize_run_http_version
// erases the key from the executed request (see execution.cpp) - and a run
// predating this field has no key at all. Neither case recorded a protocol, so
// both normalize to the literal string "auto" instead of being omitted, which
// would misrepresent "nothing was recorded" as "we lost it".
//
// Do not read that as "the run executed at auto". A load run stored before this
// branch hardcoded CURL_HTTP_VERSION_2TLS, and every run before it went out as
// HTTP/1.1 regardless because nghttp2 was not linked. "auto" here means the
// snapshot names no protocol, not that one was chosen. Never call src["httpVersion"].get<std::string>() here -
// an explicit null throws.
void add_http_version (nlohmann::json& dst, const nlohmann::json& src) {
    if (src.contains ("httpVersion") && !src["httpVersion"].is_null ()) {
        dst["httpVersion"] = src["httpVersion"];
    } else {
        dst["httpVersion"] = "auto";
    }
}

// The compact list-row summary: exactly the nine keys the history/dashboard
// list UIs read, each omitted when absent from the snapshot (httpVersion
// excepted - see add_http_version). A malformed config_snapshot yields an
// empty object, never an error - the full snapshot stays available on
// GET /runs/:id.
nlohmann::json build_run_summary (const std::string& config_snapshot) {
    nlohmann::json summary = nlohmann::json::object ();
    try {
        auto config = nlohmann::json::parse (config_snapshot);
        if (config.is_object ()) {
            for (const char* key : { "url", "method", "mode", "duration",
                 "concurrency", "comment", "followRedirects", "maxRedirects" }) {
                add_if_present (summary, config, key);
            }
            add_http_version (summary, config);
        }
    } catch (...) {
        // Malformed snapshot -> empty summary (never a 500).
    }
    return summary;
}

// Serialize one run into a list row: identity + status + the compact summary,
// deliberately *without* the full config_snapshot (that is what makes the list
// cheap). Mirrors the camelCase keys vayu::json::serialize(Run) emits.
nlohmann::json serialize_run_row (const vayu::db::Run& run) {
    nlohmann::json row;
    row["id"]        = run.id;
    row["type"]      = vayu::to_string (run.type);
    row["status"]    = vayu::to_string (run.status);
    row["startTime"] = run.start_time;
    row["endTime"]   = run.end_time;
    row["requestId"] =
    run.request_id.has_value () ? nlohmann::json (*run.request_id) : nlohmann::json (nullptr);
    row["environmentId"] = run.environment_id.has_value () ?
    nlohmann::json (*run.environment_id) :
    nlohmann::json (nullptr);
    row["summary"] = build_run_summary (run.config_snapshot);
    return row;
}

} // namespace

/**
 * Testable core of the paginated GET /runs list, returning {http_status,
 * json_body}. Always 200 - a list of zero rows is a valid list, not a 404.
 *
 * `limit`/`offset` arrive already parsed and clamped by the caller (limit
 * default 50, capped at 500; offset floored at 0); `filter` holds the already
 * validated type/status/requestId/q constraints. Rows carry the compact
 * `summary` (nine keys) instead of the full `config_snapshot`, wrapped in the
 * same `{data, pagination}` envelope GET /runs/:id/metrics uses (post-#86).
 *
 * Extracted so the envelope shape, clamping and filtering are covered without
 * an in-process HTTP server - see runs_route_test.cpp. Exceptions propagate to
 * the route's try/catch (500).
 */
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter, int64_t limit, int64_t offset) {
    const int64_t total = db.count_runs (filter);
    auto runs           = db.get_runs_paginated (filter, limit, offset);

    nlohmann::json data = nlohmann::json::array ();
    for (const auto& run : runs) {
        data.push_back (serialize_run_row (run));
    }

    nlohmann::json response;
    response["data"]                   = std::move (data);
    response["pagination"]["total"]    = total;
    response["pagination"]["limit"]    = limit;
    response["pagination"]["offset"]   = offset;
    response["pagination"]["hasMore"]  = (offset + static_cast<int64_t> (runs.size ())) < total;
    response["pagination"]["returned"] = runs.size ();
    return { 200, response };
}

/**
 * The GET /runs/:runId/report `configuration` object: the load-test tuning
 * knobs plus httpVersion/followRedirects/maxRedirects (ten keys total), built
 * from an already-parsed config_snapshot. `rps`/`targetRps` is the one
 * rename, so it stays as an inline branch in the caller rather than living in
 * this key list.
 *
 * Extracted (like get_runs_response above) so this is covered directly - see
 * runs_route_test.cpp - without the full report handler's DB/metrics reads.
 */
nlohmann::json build_run_report_config (const nlohmann::json& config) {
    nlohmann::json config_obj = nlohmann::json::object ();
    for (const char* key : { "mode", "duration", "concurrency", "startConcurrency",
         "rampUpDuration", "timeout", "comment", "followRedirects", "maxRedirects" }) {
        add_if_present (config_obj, config, key);
    }
    add_http_version (config_obj, config);
    return config_obj;
}

/**
 * Testable core of DELETE /runs/:id, returning {http_status, json_body}.
 *
 * Deleting a run that is still executing used to remove its rows while its
 * detached worker kept writing new metrics and results against the same id -
 * permanently orphaned rows, and a run that partially "un-deleted" itself as it
 * finished. So an active run is stopped first: the stop is signalled the same
 * way POST /runs/:id/stop signals it, and the delete waits for the worker to
 * hand the run over to the retained map, which it only does after its last
 * database write.
 *
 * If the worker has not settled within `stop_wait_ms` the run is *not* deleted
 * and the caller gets a 409 - a partial delete racing a live writer is the one
 * outcome worth refusing outright. The stop still stands, so a retry a moment
 * later succeeds.
 *
 * A run whose stored status is `running` but which has no context (the daemon
 * restarted under it) has no writer to race and is deleted directly.
 */
std::pair<int, nlohmann::json> delete_run_response (vayu::db::Database& db,
vayu::core::RunManager& run_manager,
const std::string& run_id,
int64_t stop_wait_ms) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, nlohmann::json{ { "error", "Run not found" } } };
    }

    if (auto context = run_manager.get_run (run_id)) {
        vayu::utils::log_info (
        "DELETE /runs/:id - Run is active, stopping it first: " + run_id);
        context->should_stop = true;
        // Wake the closed-loop controller so it observes should_stop without
        // waiting out its 50ms safety-net timeout.
        context->notify_refill ();

        // retain_run() is the worker's last act, after the final metrics flush
        // and status update, so "no longer active" is the only signal that says
        // every writer is done with this id.
        const auto deadline = std::chrono::steady_clock::now () +
        std::chrono::milliseconds (stop_wait_ms);
        while (run_manager.get_run (run_id) != nullptr) {
            if (std::chrono::steady_clock::now () >= deadline) {
                vayu::utils::log_warning (
                "DELETE /runs/:id - Run did not settle within " +
                std::to_string (stop_wait_ms) + "ms, refusing to delete: " + run_id);
                return { 409,
                    nlohmann::json{ { "error",
                    "Run is still stopping; it was not deleted. Retry once it "
                    "reports a terminal status." } } };
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (20));
        }
    }

    db.delete_run (run_id);
    return { 200,
        nlohmann::json{ { "message", "Run deleted successfully" }, { "runId", run_id } } };
}

void register_run_routes (RouteContext& ctx) {
    /**
     * GET /runs?limit=&offset=&type=&status=&requestId=&q=
     * Lists test runs (both "design" single requests and "load" tests), newest
     * first. Rows carry a compact `summary` (url/method/mode/duration/
     * concurrency/comment/httpVersion/followRedirects/maxRedirects) instead of
     * the full config_snapshot, wrapped in the `{data, pagination}` envelope.
     * See build_run_summary for the authoritative key list - keep this in step
     * with it.
     *
     * Query params:
     * - limit: page size, default 50, capped at 500
     * - offset: rows to skip, floored at 0
     * - type: "design" | "load" (invalid -> ignored)
     * - status: RunStatus string (invalid -> ignored)
     * - requestId: exact match
     * - q: case-insensitive substring over the stored config_snapshot text
     *
     * Back-compat (removed next minor): a request with *no* query params at all
     * returns the legacy bare array of full-configSnapshot rows unchanged, so
     * external scripts keep working. Any recognised param opts into the envelope.
     */
    ctx.server.Get ("/runs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const bool wants_envelope = req.has_param ("limit") || req.has_param ("offset") ||
        req.has_param ("type") || req.has_param ("status") ||
        req.has_param ("requestId") || req.has_param ("q");

        if (!wants_envelope) {
            // Legacy no-param path: today's bare array, byte-shape-identical.
            vayu::utils::log_info ("GET /runs - Fetching all runs (legacy)");
            try {
                auto runs                = ctx.db.get_all_runs ();
                nlohmann::json json_runs = nlohmann::json::array ();
                for (const auto& run : runs) {
                    json_runs.push_back (vayu::json::serialize (run));
                }
                vayu::utils::log_debug (
                "GET /runs - Returning " + std::to_string (runs.size ()) + " runs");
                res.set_content (json_runs.dump (), "application/json");
            } catch (const std::exception& e) {
                vayu::utils::log_error ("GET /runs - Error: " + std::string (e.what ()));
                send_error (res, 500, e.what ());
            }
            return;
        }

        // Parse + clamp pagination; validate filters (invalid enum -> ignored).
        int64_t limit = 50;
        if (req.has_param ("limit")) {
            try {
                limit = std::stoll (req.get_param_value ("limit"));
            } catch (...) {
                limit = 50;
            }
            if (limit <= 0)
                limit = 50;
            limit = std::min<int64_t> (limit, 500); // Cap page size.
        }
        int64_t offset = 0;
        if (req.has_param ("offset")) {
            try {
                offset = std::stoll (req.get_param_value ("offset"));
            } catch (...) {
                offset = 0;
            }
            if (offset < 0)
                offset = 0;
        }

        vayu::db::RunFilter filter;
        if (req.has_param ("type"))
            filter.type = vayu::parse_run_type (req.get_param_value ("type"));
        if (req.has_param ("status"))
            filter.status = vayu::parse_run_status (req.get_param_value ("status"));
        if (req.has_param ("requestId"))
            filter.request_id = req.get_param_value ("requestId");
        if (req.has_param ("q"))
            filter.q = req.get_param_value ("q");

        vayu::utils::log_info ("GET /runs - Listing runs (limit=" +
        std::to_string (limit) + ", offset=" + std::to_string (offset) + ")");
        try {
            auto [status, body] = get_runs_response (ctx.db, filter, limit, offset);
            res.status          = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /runs - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /runs/:runId  (alias: GET /run/:runId, deprecated)
     * Retrieves details for a specific test run by its ID.
     */
    httplib::Server::Handler get_run =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info ("GET /runs/:id - Fetching run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (run) {
                vayu::utils::log_debug ("GET /runs/:id - Found run: " + run_id +
                ", type=" + to_string (run->type) + ", status=" + to_string (run->status));
                auto payload = vayu::json::serialize (*run);
                // A design run is one exchange, so it travels with the run.
                // Load runs keep theirs in the report, where `results` means
                // the sampled subset. Guard here, before fetching - a load
                // run's results are not bounded (one row per error, uncapped)
                // and must never be pulled just to be discarded.
                if (run->type == vayu::RunType::Design)
                    vayu::json::attach_design_result (
                    payload, *run, ctx.db.get_results (run_id));
                res.set_content (payload.dump (), "application/json");
            } else {
                vayu::utils::log_warning ("GET /runs/:id - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /runs/:id - Error fetching run " + run_id + ": " + e.what ());
            send_error (res, 500, e.what ());
        }
    };
    ctx.server.Get (R"(/runs/([^/]+))", get_run);
    ctx.server.Get (R"(/run/([^/]+))", deprecated_alias (get_run));

    /**
     * DELETE /runs/:runId  (alias: DELETE /run/:runId, deprecated)
     * Deletes a specific test run and all associated metrics/results. An active
     * run is stopped first and only deleted once its worker has settled; see
     * delete_run_response.
     */
    httplib::Server::Handler delete_run =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info ("DELETE /runs/:id - Deleting run: " + run_id);
        try {
            auto [status, body] =
            delete_run_response (ctx.db, ctx.run_manager, run_id, DELETE_STOP_WAIT_MS);
            res.status = status;
            res.set_content (body.dump (), "application/json");
            if (status == 200) {
                vayu::utils::log_info (
                "DELETE /runs/:id - Successfully deleted run: " + run_id);
            } else if (status == 404) {
                vayu::utils::log_warning ("DELETE /runs/:id - Run not found: " + run_id);
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /runs/:id - Error deleting run " + run_id + ": " + e.what ());
            send_error (res, 500, e.what ());
        }
    };
    ctx.server.Delete (R"(/runs/([^/]+))", delete_run);
    ctx.server.Delete (R"(/run/([^/]+))", deprecated_alias (delete_run));

    /**
     * POST /runs/:runId/stop  (alias: POST /run/:runId/stop, deprecated)
     * Stops a running load test.
     */
    httplib::Server::Handler stop_run =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info ("POST /runs/:id/stop - Stopping run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (!run) {
                vayu::utils::log_warning (
                "POST /runs/:id/stop - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
                return;
            }

            // Check if run is already completed or stopped
            if (run->status == vayu::RunStatus::Completed ||
            run->status == vayu::RunStatus::Stopped ||
            run->status == vayu::RunStatus::Failed) {
                vayu::utils::log_info (
                "POST /runs/:id/stop - Run already finished: " + run_id +
                ", status=" + to_string (run->status));
                auto response = vayu::utils::MetricsHelper::create_already_stopped_response (
                run_id, to_string (run->status));
                res.set_content (response.dump (), "application/json");
                return;
            }

            // Try to find active run context
            auto context = ctx.run_manager.get_run (run_id);
            if (context) {
                vayu::utils::log_info (
                "POST /runs/:id/stop - Signaling stop for active run: " + run_id);
                // Signal the running thread to stop
                context->should_stop = true;
                // Wake the closed-loop controller for immediate cancellation
                // (otherwise it waits up to its 50ms safety-net timeout).
                context->notify_refill ();

                // Wait for graceful shutdown
                vayu::utils::MetricsHelper::wait_for_graceful_stop (*context, 5);

                // Calculate summary metrics
                auto summary = vayu::utils::MetricsHelper::calculate_summary (*context);
                vayu::utils::log_info ("POST /runs/:id/stop - Run stopped: " + run_id +
                ", total_requests=" + std::to_string (summary.total_requests) +
                ", errors=" + std::to_string (summary.errors));
                auto response =
                vayu::utils::MetricsHelper::create_stop_response (run_id, summary);

                res.set_content (response.dump (), "application/json");
            } else {
                // Run not active, just update DB
                vayu::utils::log_info (
                "POST /runs/:id/stop - Run not active, updating DB: " + run_id);
                ctx.db.update_run_status_with_retry (run_id, vayu::RunStatus::Stopped);

                auto response =
                vayu::utils::MetricsHelper::create_inactive_response (run_id);
                res.set_content (response.dump (), "application/json");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /runs/:id/stop - Error stopping run " + run_id + ": " + e.what ());
            send_error (res, 500, e.what ());
        }
    };
    ctx.server.Post (R"(/runs/([^/]+)/stop)", stop_run);
    ctx.server.Post (R"(/run/([^/]+)/stop)", deprecated_alias (stop_run));

    /**
     * GET /runs/:runId/report  (alias: GET /run/:runId/report, deprecated)
     * Retrieves a detailed statistical report for a specific test run.
     */
    httplib::Server::Handler get_run_report =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info (
        "GET /runs/:id/report - Generating report for run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (!run) {
                vayu::utils::log_warning (
                "GET /runs/:id/report - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
                return;
            }

            auto results = ctx.db.get_results (run_id);

            double duration_s = 0;
            if (run->start_time > 0) {
                int64_t end = run->end_time > 0 ? run->end_time : now_ms ();
                duration_s = static_cast<double> (end - run->start_time) / 1000.0;
            }

            auto report = vayu::utils::MetricsHelper::calculate_detailed_report (
            results, duration_s);

            // Enrichment fields not carried on the report struct - collected
            // from the metrics table into locals, injected into the summary JSON.
            double peak_concurrency = 0.0, dropped_total = 0.0, queue_wait_avg = 0.0;
            double bytes_sent = 0.0, bytes_received = 0.0;

            // Override calculated percentiles with HdrHistogram values from Metrics table
            auto metrics = ctx.db.get_metrics (run_id);
            for (const auto& m : metrics) {
                if (m.name == vayu::MetricName::PeakConcurrency) {
                    peak_concurrency = m.value;
                } else if (m.name == vayu::MetricName::DroppedRequests) {
                    dropped_total = m.value;
                } else if (m.name == vayu::MetricName::QueueWaitAvg) {
                    queue_wait_avg = m.value;
                } else if (m.name == vayu::MetricName::BytesSent) {
                    bytes_sent = m.value;
                } else if (m.name == vayu::MetricName::BytesReceived) {
                    bytes_received = m.value;
                } else if (m.name == vayu::MetricName::LatencyP50 && !m.labels.empty ()) {
                    // Only the labeled cumulative final-summary row counts here; the
                    // unlabeled per-tick windowed rows (persisted during the run)
                    // must not overwrite the whole-run percentile in the report.
                    report.latency_p50 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP75) {
                    report.latency_p75 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP90) {
                    report.latency_p90 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP95 && !m.labels.empty ()) {
                    report.latency_p95 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP99 && !m.labels.empty ()) {
                    report.latency_p99 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP999) {
                    report.latency_p999 = m.value;
                } else if (m.name == vayu::MetricName::LatencyMax) {
                    report.latency_max = m.value;
                } else if (m.name == vayu::MetricName::LatencyMin) {
                    report.latency_min = m.value;
                } else if (m.name == vayu::MetricName::LatencyAvg) {
                    report.latency_avg = m.value;
                } else if (m.name == vayu::MetricName::TotalRequests) {
                    report.total_requests = static_cast<size_t> (m.value);
                } else if (m.name == vayu::MetricName::Rps) {
                    report.avg_rps    = m.value;
                    report.actual_rps = m.value;
                } else if (m.name == vayu::MetricName::SendRate) {
                    report.send_rate = m.value;
                } else if (m.name == vayu::MetricName::Throughput) {
                    report.throughput = m.value;
                } else if (m.name == vayu::MetricName::TestDuration) {
                    // Use actual test duration (excludes setup/teardown overhead)
                    report.total_duration_s = m.value;
                } else if (m.name == vayu::MetricName::SetupOverhead) {
                    // Time from run creation to test start
                    report.setup_overhead_s = m.value;
                } else if (m.name == vayu::MetricName::StatusCodes && !m.labels.empty ()) {
                    // Override status codes with accurate data from metrics
                    try {
                        auto status_json = nlohmann::json::parse (m.labels);
                        report.status_codes.clear ();
                        for (auto& [code_str, count] : status_json.items ()) {
                            int code                  = std::stoi (code_str);
                            report.status_codes[code] = count.get<size_t> ();
                        }
                        // Recalculate successful/failed counts from accurate status codes
                        report.successful_requests = 0;
                        report.failed_requests     = 0;
                        for (const auto& [code, count] : report.status_codes) {
                            if (code >= 200 && code < 400) {
                                report.successful_requests += count;
                            } else {
                                report.failed_requests += count;
                            }
                        }
                        // Recalculate errors by status code
                        report.errors_by_status_code.clear ();
                        for (const auto& [code, count] : report.status_codes) {
                            if (code == 0 || code >= 400) {
                                report.errors_by_status_code[code] = count;
                            }
                        }
                    } catch (...) {
                        // Keep calculated values if parsing fails
                    }
                }
            }

            // Recompute the error rate from the reconciled successful/failed
            // split so transport errors (status code 0) are counted - the
            // sampled-results error_rate from calculate_detailed_report omits them.
            report.error_rate =
            report.total_requests > 0 ?
            static_cast<double> (report.failed_requests) * 100.0 /
            static_cast<double> (report.total_requests) :
            0.0;

            // Extract target RPS from config
            double target_rps = 0.0;
            try {
                auto config = nlohmann::json::parse (run->config_snapshot);
                if (config.contains ("rps")) {
                    target_rps = config["rps"].get<double> ();
                } else if (config.contains ("targetRps")) {
                    target_rps = config["targetRps"].get<double> ();
                }
            } catch (...) {
            }

            report.target_rps = target_rps;
            if (report.actual_rps == 0) {
                report.actual_rps = report.avg_rps;
            }
            report.rps_achievement =
            target_rps > 0 ? (report.actual_rps / target_rps * 100.0) : 0.0;

            // Fallback: calculate duration from RPS if TestDuration metric
            // wasn't stored (for backward compatibility with older runs)
            if (report.total_duration_s == duration_s &&
            report.actual_rps > 0 && report.total_requests > 0) {
                report.total_duration_s =
                static_cast<double> (report.total_requests) / report.actual_rps;
            }

            // Build response
            nlohmann::json metadata;
            metadata["runId"]     = run_id;
            metadata["runType"]   = vayu::to_string (run->type);
            metadata["status"]    = vayu::to_string (run->status);
            metadata["startTime"] = run->start_time;
            metadata["endTime"]   = run->end_time;

            try {
                auto config = nlohmann::json::parse (run->config_snapshot);
                // HTTP request fields are at root level (unified structure)
                if (config.contains ("url")) {
                    metadata["requestUrl"] = config["url"];
                }
                if (config.contains ("method")) {
                    metadata["requestMethod"] = config["method"];
                }

                nlohmann::json config_obj = build_run_report_config (config);
                // `rps` is the one rename (-> targetRps), so it stays inline
                // rather than living in build_run_report_config's key list.
                if (config.contains ("rps"))
                    config_obj["targetRps"] = config["rps"];
                if (config.contains ("targetRps"))
                    config_obj["targetRps"] = config["targetRps"];

                if (!config_obj.empty ()) {
                    metadata["configuration"] = config_obj;
                }
            } catch (...) {
            }

            nlohmann::json json_report;
            json_report["metadata"] = metadata;
            json_report["summary"] = { { "totalRequests", report.total_requests },
                { "successfulRequests", report.successful_requests },
                { "failedRequests", report.failed_requests },
                { "errorRate", report.error_rate },
                { "totalDurationSeconds", report.total_duration_s },
                { "avgRps", report.avg_rps }, { "testDuration", report.total_duration_s },
                { "sendRate", report.send_rate },
                { "throughput", report.throughput },
                { "setupOverhead", report.setup_overhead_s },
                { "peakConcurrency", static_cast<size_t> (peak_concurrency) },
                { "droppedRequests", static_cast<size_t> (dropped_total) },
                { "avgQueueWaitMs", queue_wait_avg },
                { "bytesSent", static_cast<size_t> (bytes_sent) },
                { "bytesReceived", static_cast<size_t> (bytes_received) },
                { "throughputBytesPerSec",
                report.total_duration_s > 0 ? bytes_received / report.total_duration_s : 0.0 } };
            json_report["latency"]     = { { "min", report.latency_min },
                    { "max", report.latency_max }, { "avg", report.latency_avg },
                    { "median", report.latency_p50 }, { "p50", report.latency_p50 },
                    { "p75", report.latency_p75 }, { "p90", report.latency_p90 },
                    { "p95", report.latency_p95 }, { "p99", report.latency_p99 },
                    { "p999", report.latency_p999 } };
            json_report["statusCodes"] = report.status_codes;

            if (target_rps > 0) {
                json_report["rateControl"] = { { "targetRps", report.target_rps },
                    { "actualRps", report.actual_rps },
                    { "achievement", report.rps_achievement } };
            }

            nlohmann::json errors_obj;
            errors_obj["total"]       = report.failed_requests;
            errors_obj["withDetails"] = report.errors_with_details;
            errors_obj["types"]       = report.error_types;
            if (!report.errors_by_status_code.empty ()) {
                errors_obj["byStatusCode"] = report.errors_by_status_code;
            }
            json_report["errors"] = errors_obj;

            if (report.has_timing_data) {
                json_report["timingBreakdown"] = { { "avgDnsMs", report.avg_dns_ms },
                    { "avgConnectMs", report.avg_connect_ms },
                    { "avgTlsMs", report.avg_tls_ms },
                    { "avgFirstByteMs", report.avg_first_byte_ms },
                    { "avgDownloadMs", report.avg_download_ms } };
            }

            if (report.slow_threshold_ms > 0) {
                json_report["slowRequests"] = { { "count", report.slow_requests_count },
                    { "thresholdMs", report.slow_threshold_ms },
                    { "percentage",
                    report.total_requests > 0 ?
                    (static_cast<double> (report.slow_requests_count) * 100.0 /
                    static_cast<double> (report.total_requests)) :
                    0.0 } };
            }

            // Test validation results
            int tests_passed = 0, tests_failed = 0, tests_sampled = 0;
            bool has_test_results = false;
            for (const auto& m : metrics) {
                if (m.name == vayu::MetricName::TestsPassed) {
                    tests_passed     = static_cast<int> (m.value);
                    has_test_results = true;
                } else if (m.name == vayu::MetricName::TestsFailed) {
                    tests_failed     = static_cast<int> (m.value);
                    has_test_results = true;
                } else if (m.name == vayu::MetricName::TestsSampled) {
                    tests_sampled = static_cast<int> (m.value);
                }
            }
            if (has_test_results) {
                json_report["testValidation"] = { { "samplesTested", tests_sampled },
                    { "testsPassed", tests_passed }, { "testsFailed", tests_failed },
                    { "successRate",
                    tests_sampled > 0 ? (static_cast<double> (tests_passed) * 100.0 /
                                        static_cast<double> (tests_passed + tests_failed)) :
                                        0.0 } };
            }

            // Include sample of request/response results
            nlohmann::json results_array = nlohmann::json::array ();
            size_t max_results           = 100;
            size_t count                 = 0;
            for (const auto& result : results) {
                if (count >= max_results)
                    break;
                nlohmann::json result_obj;
                result_obj["timestamp"]  = result.timestamp;
                result_obj["statusCode"] = result.status_code;
                result_obj["statusText"] = result.status_text;
                result_obj["latencyMs"]  = result.latency_ms;
                if (!result.error.empty ())
                    result_obj["error"] = result.error;
                if (!result.trace_data.empty ()) {
                    try {
                        result_obj["trace"] = nlohmann::json::parse (result.trace_data);
                    } catch (...) {
                        result_obj["trace"] = result.trace_data;
                    }
                }
                results_array.push_back (result_obj);
                count++;
            }
            json_report["results"] = results_array;

            res.set_content (json_report.dump (2), "application/json");
        } catch (const std::exception& e) {
            send_error (res, 500, e.what ());
        }
    };
    ctx.server.Get (R"(/runs/([^/]+)/report)", get_run_report);
    ctx.server.Get (R"(/run/([^/]+)/report)", deprecated_alias (get_run_report));
}

} // namespace vayu::http::routes
