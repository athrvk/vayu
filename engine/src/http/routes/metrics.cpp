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

void register_metrics_routes (RouteContext& ctx) {
    /**
     * GET /stats/:runId
     * Streams real-time statistics for a load test run using Server-Sent Events
     * (SSE). Uses database polling for historical data.
     *
     * Query Parameters:
     * - format=json: Return JSON instead of SSE (for historical chart data)
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

            // Parse pagination params
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

            try {
                auto run = ctx.db.get_run (run_id);
                if (!run) {
                    vayu::utils::log_warning ("GET /stats/:id - Run not found: " + run_id);
                    send_error (res, 404, "Run not found");
                    return;
                }

                // Get total count for pagination
                int64_t total_count = ctx.db.count_metrics (run_id);

                // Get paginated metrics
                auto metrics = ctx.db.get_metrics_paginated (run_id, limit, offset);

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
                        // Initialize with defaults
                        bucket["requests_completed"] = 0;
                        bucket["requests_failed"] = 0;
                        bucket["current_rps"] = 0.0;
                        bucket["current_concurrency"] = 0;
                        bucket["avg_latency_ms"] = 0.0;
                        bucket["latency_p50_ms"] = 0.0;
                        bucket["latency_p95_ms"] = 0.0;
                        bucket["latency_p99_ms"] = 0.0;
                        bucket["send_rate"] = 0.0;
                        bucket["throughput"] = 0.0;
                        bucket["backpressure"] = 0;
                    }

                    // Map metric values to LoadTestMetrics fields
                    if (metric.name == vayu::MetricName::Rps) {
                        bucket["current_rps"] = metric.value;
                    } else if (metric.name == vayu::MetricName::ErrorRate) {
                        int total_req = bucket.value ("requests_completed", 0);
                        bucket["requests_failed"] = static_cast<int> ((metric.value / 100.0) * total_req);
                    } else if (metric.name == vayu::MetricName::ConnectionsActive) {
                        bucket["current_concurrency"] = static_cast<int> (metric.value);
                    } else if (metric.name == vayu::MetricName::RequestsSent ||
                    metric.name == vayu::MetricName::TotalRequests) {
                        bucket["requests_completed"] = static_cast<int> (metric.value);
                    } else if (metric.name == vayu::MetricName::LatencyAvg) {
                        bucket["avg_latency_ms"] = metric.value;
                    } else if (metric.name == vayu::MetricName::LatencyP50) {
                        bucket["latency_p50_ms"] = metric.value;
                    } else if (metric.name == vayu::MetricName::LatencyP95) {
                        bucket["latency_p95_ms"] = metric.value;
                    } else if (metric.name == vayu::MetricName::LatencyP99) {
                        bucket["latency_p99_ms"] = metric.value;
                    } else if (metric.name == vayu::MetricName::SendRate) {
                        bucket["send_rate"] = metric.value;
                    } else if (metric.name == vayu::MetricName::Throughput) {
                        bucket["throughput"] = metric.value;
                    } else if (metric.name == vayu::MetricName::Backpressure) {
                        bucket["backpressure"] = static_cast<int> (metric.value);
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

                res.set_content (response.dump (), "application/json");
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
     * GET /metrics/live/:runId
     * Streams real-time metrics directly from MetricsCollector (lock-free, faster).
     */
    ctx.server.Get (R"(/metrics/live/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];

        auto context = ctx.run_manager.get_run (run_id);
        if (!context) {
            res.status = 404;
            nlohmann::json error;
            error["error"] = "Run not found or not active";
            error["hint"]  = "Use /stats/" + run_id + " for historical data";
            res.set_content (error.dump (), "application/json");
            return;
        }

        res.set_content_provider ("text/event-stream",
        [&ctx, run_id, context] (size_t offset, httplib::DataSink& sink) {
            auto start_time = std::chrono::steady_clock::now ();

            // State for instantaneous RPS calculation (delta-based)
            auto last_rps_time      = start_time;
            size_t last_total_count = 0;
            double current_rps      = 0.0;

            while (context->is_running) {
                if (!sink.is_writable ()) {
                    break;
                }

                try {
                    auto now = std::chrono::steady_clock::now ();
                    double elapsed_seconds =
                    std::chrono::duration<double> (now - start_time).count ();

                    size_t active_count =
                    context->event_loop ? context->event_loop->active_count () : 0;
                    size_t requests_sent = context->requests_sent.load ();
                    auto stats = context->metrics_collector->get_current_stats (
                    active_count, elapsed_seconds, requests_sent);

                    // Calculate instantaneous RPS (delta-based, per-interval)
                    size_t current_total = stats["totalRequests"].get<size_t> ();
                    double rps_interval =
                    std::chrono::duration<double> (now - last_rps_time).count ();
                    if (rps_interval >= 0.1) { // Update RPS every 100ms minimum
                        size_t delta = current_total - last_total_count;
                        current_rps  = static_cast<double> (delta) / rps_interval;
                        last_total_count = current_total;
                        last_rps_time    = now;
                    }
                    stats["currentRps"] = current_rps;

                    // Calculate backpressure (queue depth: sent but not yet responded)
                    size_t total_responses = current_total;
                    size_t backpressure =
                    requests_sent > total_responses ? requests_sent - total_responses : 0;
                    stats["backpressure"] = backpressure;

                    stats["runId"] = run_id;
                    stats["timestamp"] =
                    std::chrono::duration_cast<std::chrono::milliseconds> (
                    std::chrono::system_clock::now ().time_since_epoch ())
                    .count ();
                    stats["requestsSent"] = requests_sent;
                    stats["requestsExpected"] = context->requests_expected.load ();

                    std::string payload = "event: metrics\ndata: " + stats.dump () + "\n\n";
                    if (!sink.write (payload.data (), payload.size ())) {
                        return false;
                    }

                } catch (const std::exception& e) {
                    nlohmann::json error_event;
                    error_event["error"] = e.what ();
                    std::string payload =
                    "event: error\ndata: " + error_event.dump () + "\n\n";
                    sink.write (payload.data (), payload.size ());
                    break;
                }

                std::this_thread::sleep_for (std::chrono::milliseconds (100));
            }

            nlohmann::json completion_event;
            completion_event["event"] = "complete";
            completion_event["runId"] = run_id;
            completion_event["message"] =
            "Test completed, use /stats/" + run_id + " for full report";
            std::string payload =
            "event: complete\ndata: " + completion_event.dump () + "\n\n";
            sink.write (payload.data (), payload.size ());

            return false;
        });
    });
}

} // namespace vayu::http::routes
