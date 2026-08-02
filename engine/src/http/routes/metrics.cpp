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
    response["data"]                   = std::move (data);
    response["pagination"]["total"]    = total_count;
    response["pagination"]["limit"]    = limit;
    response["pagination"]["offset"]   = offset;
    response["pagination"]["hasMore"]  = (offset + static_cast<int64_t> (returned)) < total_count;
    response["pagination"]["returned"] = returned;
    return response;
}

/**
 * The current path: each `metric_ticks` row already *is* one `data[]` entry, so
 * the reader parses and forwards it. Pagination is tick-aligned by
 * construction - a page boundary can no longer land inside a tick and hand the
 * client a half-populated bucket.
 */
nlohmann::json tick_time_series (vayu::db::Database& db,
const std::string& run_id,
int64_t total_count,
int64_t limit,
int64_t offset) {
    auto ticks = db.get_metric_ticks_paginated (run_id, limit, offset);

    nlohmann::json data_array = nlohmann::json::array ();
    for (const auto& tick : ticks) {
        try {
            auto payload = nlohmann::json::parse (tick.payload);
            if (!payload.is_object ()) {
                throw std::runtime_error ("payload is not an object");
            }
            data_array.push_back (std::move (payload));
        } catch (const std::exception& e) {
            // A payload this engine wrote always parses; a corrupt one is a
            // damaged row, not a client error - skip it loudly rather than
            // failing the whole page.
            vayu::utils::log_warning ("Skipping unreadable metric tick for run " +
            run_id + " (id=" + std::to_string (tick.id) + "): " + e.what ());
        }
    }
    return time_series_envelope (
    std::move (data_array), total_count, limit, offset, ticks.size ());
}

} // namespace

/**
 * Testable core of the time-series JSON endpoint, returning {http_status,
 * json_body}. Serves both `GET /runs/:id/metrics` (canonical) and the legacy
 * `GET /stats/:id?format=json`, so the two paths cannot drift.
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
const std::string& run_id, int64_t limit, int64_t offset) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    // metric_ticks is the only time series; the count doubles as the
    // pagination total, so this is not an extra query.
    const int64_t tick_count = db.count_metric_ticks (run_id);
    return { 200, tick_time_series (db, run_id, tick_count, limit, offset) };
}

namespace {

/**
 * Fold one stored tick into the legacy `/stats/:id` SSE aggregate.
 *
 * That stream predates `metric_ticks` and read the EAV rows directly; every
 * field it carries comes from the tick object instead, one-for-one - except
 * `avgLatencyMs`, which the per-tick object has never carried (the canonical
 * `GET /runs/:id/live` stream serves it from the in-memory collector). Returns
 * false for an unreadable payload, leaving the aggregate untouched.
 */
bool apply_tick_to_stream (const vayu::db::MetricTick& tick,
nlohmann::json& aggregate,
const std::string& run_id) {
    nlohmann::json payload;
    try {
        payload = nlohmann::json::parse (tick.payload);
    } catch (...) {
        return false;
    }
    if (!payload.is_object ()) {
        return false;
    }

    const int total_req = payload.value ("requests_completed", 0);
    const int errors    = payload.value ("requests_failed", 0);
    aggregate["currentRps"]        = payload.value ("current_rps", 0.0);
    aggregate["errorRate"]         = payload.value ("error_rate", 0.0);
    aggregate["activeConnections"] = payload.value ("current_concurrency", 0);
    aggregate["totalRequests"]     = total_req;
    aggregate["sendRate"]          = payload.value ("send_rate", 0.0);
    aggregate["throughput"]        = payload.value ("throughput", 0.0);
    aggregate["backpressure"]      = payload.value ("backpressure", 0);
    aggregate["totalErrors"]       = errors;
    aggregate["totalSuccess"]      = total_req > errors ? total_req - errors : 0;
    aggregate["elapsedSeconds"]    = payload.value ("elapsed_seconds", 0.0);
    aggregate["timestamp"]         = payload.value ("timestamp", tick.timestamp);
    aggregate["runId"]             = run_id;
    return true;
}

// Parse and clamp the pagination query params shared by the time-series routes.
// Raw parsing stays here; the extracted core is handed clean, clamped ints.
// limit: default 5000, invalid/<=0 -> 5000, capped at 50000. offset: <0 -> 0.
std::pair<int64_t, int64_t> parse_time_series_pagination (const httplib::Request& req) {
    int64_t limit = 5000;
    int64_t offset = 0;
    if (req.has_param ("limit")) {
        try {
            limit = std::stoll (req.get_param_value ("limit"));
            if (limit <= 0) limit = 5000;
            if (limit > 50000) limit = 50000; // Cap at 50k for safety
        } catch (...) {
            limit = 5000;
        }
    }
    if (req.has_param ("offset")) {
        try {
            offset = std::stoll (req.get_param_value ("offset"));
            if (offset < 0) offset = 0;
        } catch (...) {
            offset = 0;
        }
    }
    return { limit, offset };
}

} // namespace

void register_metrics_routes (RouteContext& ctx) {
    /**
     * GET /runs/:runId/metrics
     * Returns the paginated time-series (JSON) for a load test run's charts.
     * Always JSON - any `format` query param is ignored. This is the canonical
     * replacement for the legacy `GET /stats/:id?format=json`; both call
     * run_time_series_response so they cannot drift.
     *
     * Query Parameters:
     * - limit: Max records per page (default 5000, capped at 50000)
     * - offset: Skip N records (default 0)
     */
    ctx.server.Get (R"(/runs/([^/]+)/metrics)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info (
        "GET /runs/:id/metrics - Fetching time-series for run: " + run_id);
        auto [limit, offset] = parse_time_series_pagination (req);
        try {
            auto [status, body] = run_time_series_response (ctx.db, run_id, limit, offset);
            if (status == 404) {
                vayu::utils::log_warning (
                "GET /runs/:id/metrics - Run not found: " + run_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /runs/:id/metrics - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /stats/:runId  (legacy, retained wholesale)
     * Streams real-time statistics for a load test run using Server-Sent Events
     * (SSE). Uses database polling for historical data.
     *
     * Query Parameters:
     * - format=json: Return JSON instead of SSE (for historical chart data).
     *   This branch is legacy; new callers should use GET /runs/:id/metrics,
     *   which shares the same run_time_series_response core.
     * - limit: Max records per page (default 5000, for format=json only)
     * - offset: Skip N records (default 0, for format=json only)
     */
    ctx.server.Get (R"(/stats/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];

        // Check for JSON format (batch retrieval for charts)
        bool json_format = req.has_param ("format") && req.get_param_value ("format") == "json";

        if (json_format) {
            vayu::utils::log_info (
            "GET /stats/:id?format=json - Fetching time-series for run: " + run_id);

            auto [limit, offset] = parse_time_series_pagination (req);
            try {
                auto [status, body] =
                run_time_series_response (ctx.db, run_id, limit, offset);
                if (status == 404) {
                    vayu::utils::log_warning ("GET /stats/:id - Run not found: " + run_id);
                }
                res.status = status;
                res.set_content (body.dump (), "application/json");
            } catch (const std::exception& e) {
                vayu::utils::log_error ("GET /stats/:id?format=json - Error: " + std::string (e.what ()));
                send_error (res, 500, e.what ());
            }
            return;
        }

        // SSE streaming mode (existing behavior)
        vayu::utils::log_info (
        "GET /stats/:id - Starting SSE stream for run: " + run_id);

        try {
            auto run = ctx.db.get_run (run_id);
            if (!run) {
                vayu::utils::log_warning ("GET /stats/:id - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
                return;
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /stats/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
            return;
        }

        res.set_content_provider ("text/event-stream",
        [&ctx, run_id] (size_t offset, httplib::DataSink& sink) {
            int64_t last_tick_id = 0; // metric_ticks cursor
            bool test_completed  = false;

            nlohmann::json aggregated_metrics;
            aggregated_metrics["totalRequests"]     = 0;
            aggregated_metrics["totalErrors"]       = 0;
            aggregated_metrics["totalSuccess"]      = 0;
            aggregated_metrics["errorRate"]         = 0.0;
            aggregated_metrics["avgLatencyMs"]      = 0.0;
            aggregated_metrics["currentRps"]        = 0.0;
            aggregated_metrics["sendRate"]          = 0.0;
            aggregated_metrics["throughput"]        = 0.0;
            aggregated_metrics["backpressure"]      = 0;
            aggregated_metrics["activeConnections"] = 0;
            aggregated_metrics["elapsedSeconds"]    = 0.0;

            while (!test_completed) {
                if (!sink.is_writable ()) {
                    break;
                }

                try {
                    auto ticks = ctx.db.get_metric_ticks_since (run_id, last_tick_id);
                    if (!ticks.empty ()) {
                        bool tick_updates = false;
                        for (const auto& tick : ticks) {
                            last_tick_id = tick.id;
                            tick_updates |= apply_tick_to_stream (
                            tick, aggregated_metrics, run_id);
                        }
                        if (tick_updates) {
                            std::string payload = "event: metrics\ndata: " +
                            aggregated_metrics.dump () + "\n\n";
                            if (!sink.write (payload.data (), payload.size ())) {
                                return false;
                            }
                        }
                    } else {
                        auto run = ctx.db.get_run (run_id);
                        if (run &&
                        (run->status == vayu::RunStatus::Completed ||
                        run->status == vayu::RunStatus::Stopped ||
                        run->status == vayu::RunStatus::Failed)) {
                            test_completed = true;

                            nlohmann::json completion_event;
                            completion_event["event"] = "complete";
                            completion_event["runId"] = run_id;
                            completion_event["status"] = to_string (run->status);
                            std::string payload =
                            "event: complete\ndata: " + completion_event.dump () + "\n\n";
                            sink.write (payload.data (), payload.size ());
                            break;
                        }

                        std::string keep_alive = ": keep-alive\n\n";
                        if (!sink.write (keep_alive.data (), keep_alive.size ())) {
                            return false;
                        }
                    }
                } catch (const std::exception& e) {
                    break;
                }

                if (test_completed) {
                    break;
                }

                std::this_thread::sleep_for (std::chrono::milliseconds (500));
            }

            return false;
        });
    });

    /**
     * GET /runs/:runId/live  (alias: GET /metrics/live/:runId, deprecated)
     * Streams real-time metrics directly from MetricsCollector (lock-free, faster).
     */
    httplib::Server::Handler live_metrics =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];

        // Evict expired retained topics, then resolve active OR within-retention.
        int retention_ms = ctx.db.get_config_int ("liveRetentionMs", 60000);
        ctx.run_manager.sweep_retained (retention_ms);

        auto context = ctx.run_manager.get_run_or_retained (run_id);
        if (!context) {
            res.status = 404;
            nlohmann::json error;
            error["error"] = "Run not found or expired";
            error["hint"]  = "Use /runs/" + run_id + "/report for the stored report";
            res.set_content (error.dump (), "application/json");
            return;
        }

        // Honor Last-Event-ID for reconnect resume (offset = last seen + 1).
        size_t start_offset = 0;
        if (req.has_header ("Last-Event-ID")) {
            try {
                start_offset = std::stoull (req.get_header_value ("Last-Event-ID")) + 1;
            } catch (...) { start_offset = 0; }
        }

        res.set_content_provider ("text/event-stream",
        [run_id, context, start_offset] (size_t, httplib::DataSink& sink) {
            size_t offset = start_offset;
            while (true) {
                if (!sink.is_writable ()) return false;

                auto batch = context->ticks_since (offset);
                for (const auto& payload : batch.payloads) {
                    if (!sink.write (payload.data (), payload.size ())) return false;
                }
                // Adopt the producer's offset rather than advancing by the batch
                // size: a resume from before the retained window skips ahead.
                offset = batch.next_offset;

                // Terminate only once the producer has appended its final tick
                // (closed) AND we have drained the buffer - never gate on
                // is_running, which can flip before the final tick lands.
                if (context->closed.load (std::memory_order_acquire) &&
                offset >= context->published_count.load (std::memory_order_acquire)) {
                    break;
                }
                if (batch.payloads.empty ()) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (50));
                }
            }

            nlohmann::json completion_event;
            completion_event["event"] = "complete";
            completion_event["runId"] = run_id;
            std::string payload =
            "event: complete\ndata: " + completion_event.dump () + "\n\n";
            sink.write (payload.data (), payload.size ());
            return false;
        });
    };
    ctx.server.Get (R"(/runs/([^/]+)/live)", live_metrics);
    ctx.server.Get (R"(/metrics/live/([^/]+))", deprecated_alias (live_metrics));
}

} // namespace vayu::http::routes
