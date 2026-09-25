/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/metrics.cpp
 * @brief Metrics streaming routes (SSE endpoints for real-time stats)
 */

#include <algorithm>
#include <thread>

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

namespace {

// Wrap the per-tick objects in the `{data, pagination}` envelope both storage
// paths return. `returned` counts the rows the query yielded, so `hasMore`
// stays correct even if one stored payload had to be skipped.
nlohmann::json time_series_envelope (nlohmann::json data,
int64_t total_count,
int64_t limit,
int64_t offset,
size_t returned) {
    nlohmann::json response;
    response["data"]                 = std::move (data);
    response["pagination"]["total"]  = total_count;
    response["pagination"]["limit"]  = limit;
    response["pagination"]["offset"] = offset;
    response["pagination"]["hasMore"] =
    (offset + static_cast<int64_t> (returned)) < total_count;
    response["pagination"]["returned"] = returned;
    return response;
}

/**
 * The current path: each `metric_ticks` row already *is* one `data[]` entry, so
 * the reader parses and forwards it. Pagination is tick-aligned by
 * construction - a page boundary can no longer land inside a tick and hand the
 * client a half-populated bucket.
 */
template <typename Row>
nlohmann::json stored_payload_series (const std::vector<Row>& rows,
const char* kind,
const std::string& run_id,
int64_t total_count,
int64_t limit,
int64_t offset) {
    nlohmann::json data_array = nlohmann::json::array ();
    for (const auto& row : rows) {
        try {
            auto payload = nlohmann::json::parse (row.payload);
            if (!payload.is_object ()) {
                throw std::runtime_error ("payload is not an object");
            }
            data_array.push_back (std::move (payload));
        } catch (const std::exception& e) {
            // A payload this engine wrote always parses; a corrupt one is a
            // damaged row, not a client error - skip it loudly rather than
            // failing the whole page.
            vayu::utils::log_warning ("http", "Skipping unreadable row",
            { { "kind", kind }, { "runId", run_id }, { "id", row.id },
            { "error", e.what () } });
        }
    }
    return time_series_envelope (
    std::move (data_array), total_count, limit, offset, rows.size ());
}

nlohmann::json tick_time_series (vayu::db::Database& db,
const std::string& run_id,
int64_t total_count,
int64_t limit,
int64_t offset) {
    return stored_payload_series (db.get_metric_ticks_paginated (run_id, limit, offset),
    "metric tick", run_id, total_count, limit, offset);
}

} // namespace

/**
 * Testable core of the time-series JSON endpoint, returning {http_status,
 * json_body}, behind `GET /runs/:id/metrics`.
 *
 * A missing run is a definitive 404 with the `{"error": {"code", "message"}}`
 * shape `send_error` uses. Otherwise it returns the run's per-tick objects (the app's
 * snake_case `LoadTestMetrics` shape, consumed without a transformer) in the
 * `{data, pagination}` envelope, read straight from `metric_ticks`. A run with
 * no ticks returns an empty `data` array, not a 404 - the run exists.
 *
 * `limit`/`offset` arrive already parsed and clamped by the caller (limit
 * default 5000, capped at 50000; offset floored at 0) - the raw query-param
 * parsing stays in the route. Extracted so the wiring (404 vs 200 + envelope,
 * pagination) is covered without an in-process HTTP server - see
 * stats_route_test.cpp. Exceptions propagate to the route's try/catch (500).
 */
std::pair<int, nlohmann::json> run_time_series_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    // metric_ticks is the only time series; the count doubles as the
    // pagination total, so this is not an extra query.
    const int64_t tick_count = db.count_metric_ticks (run_id);
    return { 200, tick_time_series (db, run_id, tick_count, limit, offset) };
}

/**
 * Testable core of `GET /runs/:id/monitor` - the external server vitals scraped
 * during a run, in the same `{data, pagination}` envelope the tick series uses.
 *
 * Its own endpoint rather than extra keys on the tick objects: those keys are
 * the `GET /runs/:id/metrics` contract, and monitor samples arrive on the
 * user's scrape cadence rather than the tick cadence, so they do not line up
 * row for row. A run that configured no monitor returns an empty `data` array,
 * not a 404 - the run exists and simply scraped nothing. A missing run is the
 * same definitive 404 the tick series returns.
 */
std::pair<int, nlohmann::json> run_monitor_series_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    const int64_t sample_count = db.count_monitor_samples (run_id);
    return { 200,
        stored_payload_series (db.get_monitor_samples_paginated (run_id, limit, offset),
        "monitor sample", run_id, sample_count, limit, offset) };
}

namespace {

// Parse and clamp the pagination query params shared by the time-series routes.
// Raw parsing stays here; the extracted core is handed clean, clamped ints.
// limit: default 5000, invalid/<=0 -> 5000, capped at 50000. offset: <0 -> 0.
std::pair<int64_t, int64_t> parse_time_series_pagination (const httplib::Request& req) {
    int64_t limit  = 5000;
    int64_t offset = 0;
    if (req.has_param ("limit")) {
        try {
            limit = std::stoll (req.get_param_value ("limit"));
            if (limit <= 0)
                limit = 5000;
            limit = std::min<int64_t> (limit, 50000); // Cap at 50k for safety
        } catch (...) {
            limit = 5000;
        }
    }
    if (req.has_param ("offset")) {
        try {
            offset =
            std::max<int64_t> (std::stoll (req.get_param_value ("offset")), 0);
        } catch (...) {
            offset = 0;
        }
    }
    return { limit, offset };
}

} // namespace

namespace {

void handle_run_metrics (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info (
    "http", "GET /runs/:id/metrics - Fetching time-series for run: " + run_id);
    auto [limit, offset] = parse_time_series_pagination (req);
    try {
        auto [status, body] = run_time_series_response (ctx.db, run_id, limit, offset);
        if (status == 404) {
            vayu::utils::log_warning (
            "http", "GET /runs/:id/metrics - Run not found: " + run_id);
        }
        res.status = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "GET /runs/:id/metrics - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_run_monitor (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info ("http",
    "GET /runs/:id/monitor - Fetching monitor samples for run: " + run_id);
    auto [limit, offset] = parse_time_series_pagination (req);
    try {
        auto [status, body] = run_monitor_series_response (ctx.db, run_id, limit, offset);
        if (status == 404) {
            vayu::utils::log_warning (
            "http", "GET /runs/:id/monitor - Run not found: " + run_id);
        }
        res.status = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "GET /runs/:id/monitor - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

/**
 * The live stream itself: every tick the run's topic has published from
 * @p start_offset on, then its completion event.
 *
 * Always answers `false` - the provider is done when this returns, whether the
 * run ended or the client went away.
 */
bool stream_live_metrics (vayu::db::Database& db,
const std::string& run_id,
const std::shared_ptr<vayu::core::RunContext>& context,
size_t start_offset,
httplib::DataSink& sink) {
    size_t offset = start_offset;
    while (sink.is_writable ()) {
        auto batch = context->ticks_since (offset);
        for (const auto& payload : batch.payloads) {
            if (!sink.write (payload.data (), payload.size ())) {
                return false;
            }
        }
        // Adopt the producer's offset rather than advancing by the batch
        // size: a resume from before the retained window skips ahead.
        offset = batch.next_offset;

        // Terminate only once the producer has appended its final tick
        // (closed) AND we have drained the buffer - never gate on
        // is_running, which can flip before the final tick lands.
        if (context->closed.load (std::memory_order_acquire) &&
        offset >= context->published_count.load (std::memory_order_acquire)) {
            nlohmann::json completion_event;
            completion_event["event"] = "complete";
            completion_event["runId"] = run_id;
            // The status, so the client can tell a failed run from a finished
            // one without going back for the report (issue #1415). This is the
            // frame an ordinary live run ends on, so without it nothing
            // downstream could see a failure.
            //
            // Omitted rather than guessed when the row is not terminal yet:
            // `closed` says the producer appended its last tick, which can
            // land just before the run's own status is written. A frame with
            // no status reads exactly as it always did, and the client falls
            // back to the report it fetches next.
            auto finished = db.get_run (run_id);
            if (finished &&
            (finished->status == vayu::RunStatus::Completed ||
            finished->status == vayu::RunStatus::Stopped ||
            finished->status == vayu::RunStatus::Failed)) {
                completion_event["status"] = to_string (finished->status);
            }
            std::string payload =
            "event: complete\ndata: " + completion_event.dump () + "\n\n";
            sink.write (payload.data (), payload.size ());
            return false;
        }
        if (batch.payloads.empty ()) {
            std::this_thread::sleep_for (std::chrono::milliseconds (50));
        }
    }
    return false;
}

/**
 * The live metrics stream, read straight off MetricsCollector rather than the
 * database (lock-free, faster).
 */
void handle_live_metrics (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];

    // Evict expired retained topics, then resolve active OR within-retention.
    int retention_ms = ctx.db.get_config_int ("liveRetentionMs", 60000);
    ctx.run_manager.sweep_retained (retention_ms);

    auto context = ctx.run_manager.get_run_or_retained (run_id);
    if (!context) {
        res.status = 404;
        nlohmann::json error;
        error["error"] = "Run not found or expired";
        error["hint"] = "Use /runs/" + run_id + "/report for the stored report";
        res.set_content (error.dump (), "application/json");
        return;
    }

    // Honor Last-Event-ID for reconnect resume (offset = last seen + 1).
    size_t start_offset = 0;
    if (req.has_header ("Last-Event-ID")) {
        try {
            start_offset =
            std::stoull (req.get_header_value ("Last-Event-ID")) + 1;
        } catch (...) {
            start_offset = 0;
        }
    }

    res.set_content_provider ("text/event-stream",
    [&db = ctx.db, run_id, context, start_offset] (size_t, httplib::DataSink& sink) {
        return stream_live_metrics (db, run_id, context, start_offset, sink);
    });
}

} // namespace

void register_metrics_routes (RouteContext& ctx) {
    /**
     * GET /runs/:runId/metrics
     * Returns the paginated time-series (JSON) for a load test run's charts.
     * Always JSON - any `format` query param is ignored.
     *
     * Query Parameters:
     * - limit: Max records per page (default 5000, capped at 50000)
     * - offset: Skip N records (default 0)
     */
    ctx.server.Get (R"(/runs/([^/]+)/metrics)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_run_metrics (ctx, req, res);
    });

    /**
     * GET /runs/:runId/monitor
     * Returns the paginated server-vitals series scraped during the run, for
     * the same charts the live `monitor` SSE frames feed.
     *
     * Query Parameters:
     * - limit: Max records per page (default 5000, capped at 50000)
     * - offset: Skip N records (default 0)
     */
    ctx.server.Get (R"(/runs/([^/]+)/monitor)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_run_monitor (ctx, req, res);
    });

    /**
     * GET /runs/:runId/live
     * Streams real-time metrics directly from MetricsCollector (lock-free, faster).
     */
    ctx.server.Get (R"(/runs/([^/]+)/live)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_live_metrics (ctx, req, res);
    });
}

} // namespace vayu::http::routes
