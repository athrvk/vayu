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

namespace vayu::http::routes {

void register_run_routes (RouteContext& ctx) {
    /**
     * GET /runs
     * Retrieves all test runs from the database.
     * Returns both "design" mode single requests and "load" mode test runs.
     */
    ctx.server.Get ("/runs", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("GET /runs - Fetching all runs");
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
    });

    /**
     * GET /run/:runId
     * Retrieves details for a specific test run by its ID.
     */
    ctx.server.Get (R"(/run/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info ("GET /run/:id - Fetching run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (run) {
                vayu::utils::log_debug ("GET /run/:id - Found run: " + run_id +
                ", type=" + to_string (run->type) + ", status=" + to_string (run->status));
                res.set_content (vayu::json::serialize (*run).dump (), "application/json");
            } else {
                vayu::utils::log_warning ("GET /run/:id - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /run/:id - Error fetching run " + run_id + ": " + e.what ());
            send_error (res, 500, e.what ());
        }
    });

    /**
     * DELETE /run/:runId
     * Deletes a specific test run and all associated metrics/results.
     */
    ctx.server.Delete (R"(/run/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info ("DELETE /run/:id - Deleting run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (!run) {
                vayu::utils::log_warning ("DELETE /run/:id - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
                return;
            }

            ctx.db.delete_run (run_id);
            vayu::utils::log_info (
            "DELETE /run/:id - Successfully deleted run: " + run_id);

            nlohmann::json response;
            response["message"] = "Run deleted successfully";
            response["runId"]   = run_id;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /run/:id - Error deleting run " + run_id + ": " + e.what ());
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /run/:runId/stop
     * Stops a running load test.
     */
    ctx.server.Post (R"(/run/([^/]+)/stop)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info ("POST /run/:id/stop - Stopping run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (!run) {
                vayu::utils::log_warning (
                "POST /run/:id/stop - Run not found: " + run_id);
                send_error (res, 404, "Run not found");
                return;
            }

            // Check if run is already completed or stopped
            if (run->status == vayu::RunStatus::Completed ||
            run->status == vayu::RunStatus::Stopped ||
            run->status == vayu::RunStatus::Failed) {
                vayu::utils::log_info (
                "POST /run/:id/stop - Run already finished: " + run_id +
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
                "POST /run/:id/stop - Signaling stop for active run: " + run_id);
                // Signal the running thread to stop
                context->should_stop = true;

                // Wait for graceful shutdown
                vayu::utils::MetricsHelper::wait_for_graceful_stop (*context, 5);

                // Calculate summary metrics
                auto summary = vayu::utils::MetricsHelper::calculate_summary (*context);
                vayu::utils::log_info ("POST /run/:id/stop - Run stopped: " + run_id +
                ", total_requests=" + std::to_string (summary.total_requests) +
                ", errors=" + std::to_string (summary.errors));
                auto response =
                vayu::utils::MetricsHelper::create_stop_response (run_id, summary);

                res.set_content (response.dump (), "application/json");
            } else {
                // Run not active, just update DB
                vayu::utils::log_info (
                "POST /run/:id/stop - Run not active, updating DB: " + run_id);
                ctx.db.update_run_status_with_retry (run_id, vayu::RunStatus::Stopped);

                auto response =
                vayu::utils::MetricsHelper::create_inactive_response (run_id);
                res.set_content (response.dump (), "application/json");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /run/:id/stop - Error stopping run " + run_id + ": " + e.what ());
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /run/:runId/report
     * Retrieves a detailed statistical report for a specific test run.
     */
    ctx.server.Get (R"(/run/([^/]+)/report)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id = req.matches[1];
        vayu::utils::log_info (
        "GET /run/:id/report - Generating report for run: " + run_id);
        try {
            auto run = ctx.db.get_run (run_id);
            if (!run) {
                vayu::utils::log_warning (
                "GET /run/:id/report - Run not found: " + run_id);
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

            // Override calculated percentiles with HdrHistogram values from Metrics table
            auto metrics = ctx.db.get_metrics (run_id);
            for (const auto& m : metrics) {
                if (m.name == vayu::MetricName::LatencyP50) {
                    report.latency_p50 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP75) {
                    report.latency_p75 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP90) {
                    report.latency_p90 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP95) {
                    report.latency_p95 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP99) {
                    report.latency_p99 = m.value;
                } else if (m.name == vayu::MetricName::LatencyP999) {
                    report.latency_p999 = m.value;
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

                nlohmann::json config_obj;
                if (config.contains ("mode"))
                    config_obj["mode"] = config["mode"];
                if (config.contains ("duration"))
                    config_obj["duration"] = config["duration"];
                if (config.contains ("rps"))
                    config_obj["targetRps"] = config["rps"];
                if (config.contains ("targetRps"))
                    config_obj["targetRps"] = config["targetRps"];
                if (config.contains ("concurrency"))
                    config_obj["concurrency"] = config["concurrency"];
                if (config.contains ("timeout"))
                    config_obj["timeout"] = config["timeout"];
                if (config.contains ("comment") && !config["comment"].is_null ())
                    config_obj["comment"] = config["comment"];

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
                { "setupOverhead", report.setup_overhead_s } };
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
    });
}

} // namespace vayu::http::routes
