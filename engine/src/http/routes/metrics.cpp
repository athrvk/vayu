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

#include <map>
#include <thread>

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

/**
 * Testable core of the time-series JSON endpoint, returning {http_status,
 * json_body}. Serves both `GET /runs/:id/metrics` (canonical) and the legacy
 * `GET /stats/:id?format=json`, so the two paths cannot drift.
 *
 * A missing run is a definitive 404 with the flat `{"error": message}` shape
 * `send_error` uses. Otherwise it groups the paginated `metrics` rows into
 * per-timestamp tick buckets (the app's snake_case `LoadTestMetrics` shape,
 * consumed without a transformer) and wraps them in the `{data, pagination}`
 * envelope.
 *
 * `limit`/`offset` arrive already parsed and clamped by the caller (limit
 * default 5000, capped at 50000; offset floored at 0) - the raw query-param
 * parsing stays in the route. Extracted so the wiring (404 vs 200 + envelope,
 * grouping, pagination) is covered without an in-process HTTP server - see
 * stats_route_test.cpp. Exceptions propagate to the route's try/catch (500).
 */
std::pair<int, nlohmann::json> run_time_series_response (vayu::db::Database& db,
const std::string& run_id, int64_t limit, int64_t offset) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, nlohmann::json{ { "error", "Run not found" } } };
    }

    // Get total count for pagination
    int64_t total_count = db.count_metrics (run_id);

    // Get paginated metrics
    auto metrics = db.get_metrics_paginated (run_id, limit, offset);

    // Group metrics by timestamp into LoadTestMetrics-compatible format
    std::map<int64_t, nlohmann::json> time_buckets;
    int64_t start_time = 0;

    for (const auto& metric : metrics) {
        if (start_time == 0) {
            start_time = metric.timestamp;
        }

        auto& bucket = time_buckets[metric.timestamp];
        if (!bucket.contains ("timestamp")) {
            bucket["timestamp"] = metric.timestamp;
            bucket["elapsed_seconds"] = static_cast<double> (metric.timestamp - start_time) / 1000.0;
            // Initialize with defaults (only metrics stored periodically during test)
            bucket["requests_completed"] = 0;
            bucket["requests_failed"] = 0;
            bucket["current_rps"] = 0.0;
            bucket["current_concurrency"] = 0;
            bucket["send_rate"] = 0.0;
            bucket["throughput"] = 0.0;
            bucket["backpressure"] = 0;
            bucket["error_rate"] = 0.0;
            bucket["dropped_requests"] = 0;
            bucket["bytes_sent"] = 0;
            bucket["bytes_received"] = 0;
            bucket["status_codes"] = nlohmann::json::object ();
            // Windowed per-tick latency percentiles (0 until a tick
            // carries them). Snake_case keys match the app's
            // LoadTestMetrics shape (consumed without a transformer).
            bucket["latency_p50_ms"] = 0.0;
            bucket["latency_p95_ms"] = 0.0;
            bucket["latency_p99_ms"] = 0.0;
        }

        // Map metric values to LoadTestMetrics fields. Latency percentiles
        // are now persisted per-tick as windowed (rolling) values -
        // unlabeled rows; the labeled cumulative final-summary rows are
        // skipped here so the series stays purely windowed.
        if (metric.name == vayu::MetricName::Rps) {
            bucket["current_rps"] = metric.value;
        } else if (metric.name == vayu::MetricName::ErrorRate) {
            bucket["error_rate"] = metric.value;
            int total_req = bucket.value ("requests_completed", 0);
            bucket["requests_failed"] = static_cast<int> ((metric.value / 100.0) * total_req);
        } else if (metric.name == vayu::MetricName::ConnectionsActive) {
            bucket["current_concurrency"] = static_cast<int> (metric.value);
        } else if (metric.name == vayu::MetricName::RequestsSent ||
        metric.name == vayu::MetricName::TotalRequests) {
            bucket["requests_completed"] = static_cast<int> (metric.value);
        } else if (metric.name == vayu::MetricName::SendRate) {
            bucket["send_rate"] = metric.value;
        } else if (metric.name == vayu::MetricName::Throughput) {
            bucket["throughput"] = metric.value;
        } else if (metric.name == vayu::MetricName::Backpressure) {
            bucket["backpressure"] = static_cast<int> (metric.value);
        } else if (metric.name == vayu::MetricName::DroppedRequests) {
            bucket["dropped_requests"] = static_cast<int> (metric.value);
        } else if (metric.name == vayu::MetricName::BytesSent) {
            bucket["bytes_sent"] = static_cast<size_t> (metric.value);
        } else if (metric.name == vayu::MetricName::BytesReceived) {
            bucket["bytes_received"] = static_cast<size_t> (metric.value);
        } else if (metric.name == vayu::MetricName::LatencyP50 &&
        metric.labels.empty ()) {
            bucket["latency_p50_ms"] = metric.value;
        } else if (metric.name == vayu::MetricName::LatencyP95 &&
        metric.labels.empty ()) {
            bucket["latency_p95_ms"] = metric.value;
        } else if (metric.name == vayu::MetricName::LatencyP99 &&
        metric.labels.empty ()) {
            bucket["latency_p99_ms"] = metric.value;
        } else if (metric.name == vayu::MetricName::StatusCodes &&
        !metric.labels.empty ()) {
            // Last-write-wins per timestamp (the final StatusCodes row
            // shares this name and lands in the last bucket).
            try {
                bucket["status_codes"] = nlohmann::json::parse (metric.labels);
            } catch (...) {
                // leave default {}
            }
        }
    }

    // Convert map to sorted array
    nlohmann::json data_array = nlohmann::json::array ();
    for (const auto& [ts, bucket] : time_buckets) {
        data_array.push_back (bucket);
    }

    // Build response with pagination metadata
    nlohmann::json response;
    response["data"] = data_array;
    response["pagination"]["total"] = total_count;
    response["pagination"]["limit"] = limit;
    response["pagination"]["offset"] = offset;
    response["pagination"]["hasMore"] = (offset + static_cast<int64_t> (metrics.size ())) < total_count;
    response["pagination"]["returned"] = metrics.size ();

    return { 200, response };
}

namespace {

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
            int64_t last_id     = 0;
            bool test_completed = false;
            int64_t start_time  = 0;

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
                    auto metrics = ctx.db.get_metrics_since (run_id, last_id);
                    bool has_updates = false;

                    if (!metrics.empty ()) {
                        for (const auto& metric : metrics) {
                            last_id = metric.id;

                            if (start_time == 0) {
                                start_time = metric.timestamp;
                            }

                            if (metric.name == vayu::MetricName::Rps) {
                                aggregated_metrics["currentRps"] = metric.value;
                                has_updates                      = true;
                            } else if (metric.name == vayu::MetricName::ErrorRate) {
                                aggregated_metrics["errorRate"] = metric.value;
                                has_updates                     = true;
                            } else if (metric.name == vayu::MetricName::ConnectionsActive) {
                                aggregated_metrics["activeConnections"] =
                                static_cast<int> (metric.value);
                                has_updates = true;
                            } else if (metric.name == vayu::MetricName::RequestsSent ||
                            metric.name == vayu::MetricName::TotalRequests) {
                                aggregated_metrics["totalRequests"] =
                                static_cast<int> (metric.value);
                                has_updates = true;
                            } else if (metric.name == vayu::MetricName::LatencyAvg) {
                                aggregated_metrics["avgLatencyMs"] = metric.value;
                                has_updates = true;
                            } else if (metric.name == vayu::MetricName::SendRate) {
                                aggregated_metrics["sendRate"] = metric.value;
                                has_updates = true;
                            } else if (metric.name == vayu::MetricName::Throughput) {
                                aggregated_metrics["throughput"] = metric.value;
                                has_updates = true;
                            } else if (metric.name == vayu::MetricName::Backpressure) {
                                aggregated_metrics["backpressure"] =
                                static_cast<int> (metric.value);
                                has_updates = true;
                            }

                            int total_req = aggregated_metrics["totalRequests"];
                            double err_rate = aggregated_metrics["errorRate"];
                            aggregated_metrics["totalErrors"] =
                            static_cast<int> ((err_rate / 100.0) * total_req);
                            aggregated_metrics["totalSuccess"] = total_req -
                            aggregated_metrics["totalErrors"].get<int> ();
                            aggregated_metrics["elapsedSeconds"] =
                            static_cast<double> (metric.timestamp - start_time) / 1000.0;
                            aggregated_metrics["timestamp"] = metric.timestamp;
                            aggregated_metrics["runId"]     = run_id;

                            if (metric.name == vayu::MetricName::Completed) {
                                test_completed = true;
                            }
                        }

                        if (has_updates || test_completed) {
                            std::string payload =
                            "event: metrics\ndata: " + aggregated_metrics.dump () + "\n\n";
                            if (!sink.write (payload.data (), payload.size ())) {
                                return false;
                            }
                        }

                        if (test_completed) {
                            nlohmann::json completion_event;
                            completion_event["event"] = "complete";
                            completion_event["runId"] = run_id;
                            std::string completion_payload =
                            "event: complete\ndata: " + completion_event.dump () + "\n\n";
                            sink.write (completion_payload.data (),
                            completion_payload.size ());
                            break;
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
                for (const auto& payload : batch) {
                    if (!sink.write (payload.data (), payload.size ())) return false;
                }
                offset += batch.size ();

                // Terminate only once the producer has appended its final tick
                // (closed) AND we have drained the buffer - never gate on
                // is_running, which can flip before the final tick lands.
                if (context->closed.load (std::memory_order_acquire) &&
                offset >= context->published_count.load (std::memory_order_acquire)) {
                    break;
                }
                if (batch.empty ()) {
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
