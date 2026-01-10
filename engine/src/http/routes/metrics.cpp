/**
 * @file http/routes/metrics.cpp
 * @brief Metrics streaming and health check routes
 */

#include <thread>

#include "vayu/core/constants.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/metrics_helper.hpp"
#include "vayu/version.hpp"

namespace vayu::http::routes {

void register_health_routes(RouteContext& ctx) {
    /**
     * GET /health
     * Returns server health status, version, and available worker threads.
     */
    ctx.server.Get("/health", [](const httplib::Request&, httplib::Response& res) {
        nlohmann::json response;
        response["status"] = "ok";
        response["version"] = vayu::Version::string;
        response["workers"] = std::thread::hardware_concurrency();
        res.set_content(response.dump(), "application/json");
    });

    /**
     * GET /config
     * Retrieves the global configuration settings.
     */
    ctx.server.Get("/config", [&ctx](const httplib::Request&, httplib::Response& res) {
        nlohmann::json config;

        auto stored_config = ctx.db.get_config("global_settings");
        if (stored_config) {
            try {
                config = nlohmann::json::parse(*stored_config);
            } catch (...) {
            }
        }

        if (config.empty()) {
            config["workers"] = std::thread::hardware_concurrency();
            config["maxConnections"] = vayu::core::constants::server::MAX_CONNECTIONS;
            config["defaultTimeout"] = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
            config["statsInterval"] = vayu::core::constants::server::STATS_INTERVAL_MS;
            config["contextPoolSize"] = vayu::core::constants::server::CONTEXT_POOL_SIZE;
        }

        res.set_content(config.dump(2), "application/json");
    });
}

void register_metrics_routes(RouteContext& ctx) {
    /**
     * GET /stats/:runId
     * Streams real-time statistics for a load test run using Server-Sent Events (SSE).
     * Uses database polling for historical data.
     */
    ctx.server.Get(
        R"(/stats/([^/]+))", [&ctx](const httplib::Request& req, httplib::Response& res) {
            std::string run_id = req.matches[1];

            try {
                auto run = ctx.db.get_run(run_id);
                if (!run) {
                    send_error(res, 404, "Run not found");
                    return;
                }
            } catch (const std::exception& e) {
                send_error(res, 500, e.what());
                return;
            }

            res.set_content_provider(
                "text/event-stream", [&ctx, run_id](size_t offset, httplib::DataSink& sink) {
                    int64_t last_id = 0;
                    bool test_completed = false;
                    int64_t start_time = 0;

                    nlohmann::json aggregated_metrics;
                    aggregated_metrics["total_requests"] = 0;
                    aggregated_metrics["total_errors"] = 0;
                    aggregated_metrics["total_success"] = 0;
                    aggregated_metrics["error_rate"] = 0.0;
                    aggregated_metrics["avg_latency_ms"] = 0.0;
                    aggregated_metrics["current_rps"] = 0.0;
                    aggregated_metrics["active_connections"] = 0;
                    aggregated_metrics["elapsed_seconds"] = 0.0;

                    while (!test_completed) {
                        if (!sink.is_writable()) {
                            break;
                        }

                        try {
                            auto metrics = ctx.db.get_metrics_since(run_id, last_id);
                            bool has_updates = false;

                            if (!metrics.empty()) {
                                for (const auto& metric : metrics) {
                                    last_id = metric.id;

                                    if (start_time == 0) {
                                        start_time = metric.timestamp;
                                    }

                                    if (metric.name == vayu::MetricName::Rps) {
                                        aggregated_metrics["current_rps"] = metric.value;
                                        has_updates = true;
                                    } else if (metric.name == vayu::MetricName::ErrorRate) {
                                        aggregated_metrics["error_rate"] = metric.value;
                                        has_updates = true;
                                    } else if (metric.name == vayu::MetricName::ConnectionsActive) {
                                        aggregated_metrics["active_connections"] =
                                            static_cast<int>(metric.value);
                                        has_updates = true;
                                    } else if (metric.name == vayu::MetricName::RequestsSent ||
                                               metric.name == vayu::MetricName::TotalRequests) {
                                        aggregated_metrics["total_requests"] =
                                            static_cast<int>(metric.value);
                                        has_updates = true;
                                    } else if (metric.name == vayu::MetricName::LatencyAvg) {
                                        aggregated_metrics["avg_latency_ms"] = metric.value;
                                        has_updates = true;
                                    }

                                    int total_req = aggregated_metrics["total_requests"];
                                    double err_rate = aggregated_metrics["error_rate"];
                                    aggregated_metrics["total_errors"] =
                                        static_cast<int>((err_rate / 100.0) * total_req);
                                    aggregated_metrics["total_success"] =
                                        total_req - aggregated_metrics["total_errors"].get<int>();
                                    aggregated_metrics["elapsed_seconds"] =
                                        static_cast<double>(metric.timestamp - start_time) / 1000.0;
                                    aggregated_metrics["timestamp"] = metric.timestamp;
                                    aggregated_metrics["run_id"] = run_id;

                                    if (metric.name == vayu::MetricName::Completed) {
                                        test_completed = true;
                                    }
                                }

                                if (has_updates || test_completed) {
                                    std::string payload =
                                        "event: metrics\ndata: " + aggregated_metrics.dump() +
                                        "\n\n";
                                    if (!sink.write(payload.data(), payload.size())) {
                                        return false;
                                    }
                                }

                                if (test_completed) {
                                    nlohmann::json completion_event;
                                    completion_event["event"] = "complete";
                                    completion_event["run_id"] = run_id;
                                    std::string completion_payload =
                                        "event: complete\ndata: " + completion_event.dump() +
                                        "\n\n";
                                    sink.write(completion_payload.data(),
                                               completion_payload.size());
                                    break;
                                }
                            } else {
                                auto run = ctx.db.get_run(run_id);
                                if (run && (run->status == vayu::RunStatus::Completed ||
                                            run->status == vayu::RunStatus::Stopped ||
                                            run->status == vayu::RunStatus::Failed)) {
                                    test_completed = true;

                                    nlohmann::json completion_event;
                                    completion_event["event"] = "complete";
                                    completion_event["run_id"] = run_id;
                                    completion_event["status"] = to_string(run->status);
                                    std::string payload =
                                        "event: complete\ndata: " + completion_event.dump() +
                                        "\n\n";
                                    sink.write(payload.data(), payload.size());
                                    break;
                                }

                                std::string keep_alive = ": keep-alive\n\n";
                                if (!sink.write(keep_alive.data(), keep_alive.size())) {
                                    return false;
                                }
                            }
                        } catch (const std::exception& e) {
                            break;
                        }

                        if (test_completed) {
                            break;
                        }

                        std::this_thread::sleep_for(std::chrono::milliseconds(500));
                    }

                    return false;
                });
        });

    /**
     * GET /metrics/live/:runId
     * Streams real-time metrics directly from MetricsCollector (lock-free, faster).
     */
    ctx.server.Get(
        R"(/metrics/live/([^/]+))", [&ctx](const httplib::Request& req, httplib::Response& res) {
            std::string run_id = req.matches[1];

            auto context = ctx.run_manager.get_run(run_id);
            if (!context) {
                res.status = 404;
                nlohmann::json error;
                error["error"] = "Run not found or not active";
                error["hint"] = "Use /stats/" + run_id + " for historical data";
                res.set_content(error.dump(), "application/json");
                return;
            }

            res.set_content_provider(
                "text/event-stream",
                [&ctx, run_id, context](size_t offset, httplib::DataSink& sink) {
                    auto start_time = std::chrono::steady_clock::now();

                    while (context->is_running) {
                        if (!sink.is_writable()) {
                            break;
                        }

                        try {
                            auto now = std::chrono::steady_clock::now();
                            double elapsed_seconds =
                                std::chrono::duration<double>(now - start_time).count();

                            size_t active_count =
                                context->event_loop ? context->event_loop->active_count() : 0;
                            auto stats = context->metrics_collector->get_current_stats(
                                active_count, elapsed_seconds);

                            stats["run_id"] = run_id;
                            stats["timestamp"] =
                                std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::system_clock::now().time_since_epoch())
                                    .count();
                            stats["requests_sent"] = context->requests_sent.load();
                            stats["requests_expected"] = context->requests_expected.load();

                            std::string payload = "event: metrics\ndata: " + stats.dump() + "\n\n";
                            if (!sink.write(payload.data(), payload.size())) {
                                return false;
                            }

                        } catch (const std::exception& e) {
                            nlohmann::json error_event;
                            error_event["error"] = e.what();
                            std::string payload =
                                "event: error\ndata: " + error_event.dump() + "\n\n";
                            sink.write(payload.data(), payload.size());
                            break;
                        }

                        std::this_thread::sleep_for(std::chrono::milliseconds(100));
                    }

                    nlohmann::json completion_event;
                    completion_event["event"] = "complete";
                    completion_event["run_id"] = run_id;
                    completion_event["message"] =
                        "Test completed, use /stats/" + run_id + " for full report";
                    std::string payload =
                        "event: complete\ndata: " + completion_event.dump() + "\n\n";
                    sink.write(payload.data(), payload.size());

                    return false;
                });
        });
}

}  // namespace vayu::http::routes
