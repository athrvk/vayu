#include "vayu/utils/metrics_helper.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <numeric>
#include <thread>

#include "vayu/core/constants.hpp"

namespace vayu::utils {

MetricsHelper::RunSummary MetricsHelper::calculate_summary(const vayu::core::RunContext& context) {
    RunSummary summary;
    summary.total_requests = context.total_requests();
    summary.errors = context.total_errors();
    summary.avg_latency_ms =
        summary.total_requests > 0
            ? context.total_latency_ms() / static_cast<double>(summary.total_requests)
            : 0.0;
    summary.error_rate =
        summary.total_requests > 0
            ? (summary.errors * vayu::core::metrics::PERCENTAGE_MULTIPLIER / summary.total_requests)
            : 0.0;

    return summary;
}

MetricsHelper::DetailedReport MetricsHelper::calculate_detailed_report(
    const std::vector<vayu::db::Result>& results, double duration_s) {
    DetailedReport report{};
    report.total_duration_s = duration_s;
    report.has_timing_data = false;
    report.slow_threshold_ms = 0;

    if (results.empty()) {
        return report;
    }

    std::vector<double> latencies;
    latencies.reserve(results.size());
    double total_latency = 0;

    // Timing breakdown accumulators
    double total_dns = 0, total_connect = 0, total_tls = 0;
    double total_first_byte = 0, total_download = 0;
    size_t timing_samples = 0;

    for (const auto& result : results) {
        report.total_requests++;
        report.status_codes[result.status_code]++;

        if (result.status_code >= 200 && result.status_code < 400) {
            report.successful_requests++;
        } else {
            report.failed_requests++;
        }

        latencies.push_back(result.latency_ms);
        total_latency += result.latency_ms;

        // Parse trace_data for enhanced metrics
        if (!result.trace_data.empty()) {
            try {
                auto trace = nlohmann::json::parse(result.trace_data);

                // Check for error details
                if (trace.contains("error_type")) {
                    report.errors_with_details++;
                    std::string error_type = trace["error_type"].get<std::string>();
                    report.error_types[error_type]++;
                }

                // Check for timing breakdown
                if (trace.contains("dns_ms")) {
                    report.has_timing_data = true;
                    timing_samples++;
                    total_dns += trace["dns_ms"].get<double>();
                    total_connect += trace["connect_ms"].get<double>();
                    total_tls += trace["tls_ms"].get<double>();
                    total_first_byte += trace["first_byte_ms"].get<double>();
                    total_download += trace["download_ms"].get<double>();
                }

                // Check for slow requests
                if (trace.contains("is_slow") && trace["is_slow"].get<bool>()) {
                    report.slow_requests_count++;
                    if (trace.contains("threshold_ms") && report.slow_threshold_ms == 0) {
                        report.slow_threshold_ms = trace["threshold_ms"].get<size_t>();
                    }
                }
            } catch (const std::exception&) {
                // Skip invalid JSON
            }
        }
    }

    // Calculate averages and rates
    report.error_rate =
        report.total_requests > 0
            ? (static_cast<double>(report.failed_requests) * 100.0 / report.total_requests)
            : 0.0;

    report.avg_rps = duration_s > 0 ? report.total_requests / duration_s : 0.0;
    report.latency_avg = report.total_requests > 0 ? total_latency / report.total_requests : 0.0;

    // Calculate timing breakdown averages
    if (timing_samples > 0) {
        report.avg_dns_ms = total_dns / timing_samples;
        report.avg_connect_ms = total_connect / timing_samples;
        report.avg_tls_ms = total_tls / timing_samples;
        report.avg_first_byte_ms = total_first_byte / timing_samples;
        report.avg_download_ms = total_download / timing_samples;
    }

    // Calculate percentiles
    if (!latencies.empty()) {
        std::sort(latencies.begin(), latencies.end());
        report.latency_min = latencies.front();
        report.latency_max = latencies.back();

        auto get_percentile = [&](double p) {
            size_t idx = static_cast<size_t>(std::ceil(p * latencies.size())) - 1;
            // Clamp index to valid range
            idx = std::max(size_t(0), std::min(idx, latencies.size() - 1));
            return latencies[idx];
        };

        report.latency_p50 = get_percentile(0.50);
        report.latency_p90 = get_percentile(0.90);
        report.latency_p95 = get_percentile(0.95);
        report.latency_p99 = get_percentile(0.99);
    }

    return report;
}

nlohmann::json MetricsHelper::create_stop_response(const std::string& run_id,
                                                   const RunSummary& summary) {
    nlohmann::json response;
    response["status"] = "stopped";
    response["runId"] = run_id;
    response["summary"] = {{"totalRequests", summary.total_requests},
                           {"errors", summary.errors},
                           {"errorRate", summary.error_rate},
                           {"avgLatencyMs", summary.avg_latency_ms}};
    return response;
}

nlohmann::json MetricsHelper::create_inactive_response(const std::string& run_id) {
    nlohmann::json response;
    response["status"] = "stopped";
    response["runId"] = run_id;
    response["message"] = "Run was not active";
    return response;
}

nlohmann::json MetricsHelper::create_already_stopped_response(const std::string& run_id,
                                                              const std::string& status) {
    nlohmann::json response;
    response["status"] = status;
    response["runId"] = run_id;
    response["message"] = "Run already " + status;
    return response;
}

bool MetricsHelper::wait_for_graceful_stop(vayu::core::RunContext& context, int timeout_seconds) {
    auto wait_start = std::chrono::steady_clock::now();

    while (context.is_running) {
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                           std::chrono::steady_clock::now() - wait_start)
                           .count();

        if (elapsed >= timeout_seconds) {
            return false;  // Timeout
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    return true;  // Stopped successfully
}

}  // namespace vayu::utils
