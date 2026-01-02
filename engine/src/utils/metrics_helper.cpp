#include "vayu/utils/metrics_helper.hpp"
#include "vayu/core/constants.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <numeric>
#include <thread>

namespace vayu::utils
{

    MetricsHelper::RunSummary MetricsHelper::calculate_summary(const vayu::core::RunContext &context)
    {
        RunSummary summary;
        summary.total_requests = context.total_requests.load();
        summary.errors = context.total_errors.load();
        summary.avg_latency_ms = summary.total_requests > 0
                                     ? context.total_latency_ms.load() / static_cast<double>(summary.total_requests)
                                     : 0.0;
        summary.error_rate = summary.total_requests > 0
                                 ? (summary.errors * vayu::core::metrics::PERCENTAGE_MULTIPLIER / summary.total_requests)
                                 : 0.0;

        return summary;
    }

    MetricsHelper::DetailedReport MetricsHelper::calculate_detailed_report(const std::vector<vayu::db::Result> &results, double duration_s)
    {
        DetailedReport report{};
        report.total_duration_s = duration_s;

        if (results.empty())
        {
            return report;
        }

        std::vector<double> latencies;
        latencies.reserve(results.size());
        double total_latency = 0;

        for (const auto &result : results)
        {
            report.total_requests++;
            report.status_codes[result.status_code]++;

            if (result.status_code >= 200 && result.status_code < 400)
            {
                report.successful_requests++;
            }
            else
            {
                report.failed_requests++;
            }

            latencies.push_back(result.latency_ms);
            total_latency += result.latency_ms;
        }

        // Calculate averages and rates
        report.error_rate = report.total_requests > 0
                                ? (static_cast<double>(report.failed_requests) * 100.0 / report.total_requests)
                                : 0.0;

        report.avg_rps = duration_s > 0 ? report.total_requests / duration_s : 0.0;
        report.latency_avg = report.total_requests > 0 ? total_latency / report.total_requests : 0.0;

        // Calculate percentiles
        if (!latencies.empty())
        {
            std::sort(latencies.begin(), latencies.end());
            report.latency_min = latencies.front();
            report.latency_max = latencies.back();

            auto get_percentile = [&](double p)
            {
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

    nlohmann::json MetricsHelper::create_stop_response(const std::string &run_id, const RunSummary &summary)
    {
        nlohmann::json response;
        response["status"] = "stopped";
        response["runId"] = run_id;
        response["summary"] = {
            {"totalRequests", summary.total_requests},
            {"errors", summary.errors},
            {"errorRate", summary.error_rate},
            {"avgLatencyMs", summary.avg_latency_ms}};
        return response;
    }

    nlohmann::json MetricsHelper::create_inactive_response(const std::string &run_id)
    {
        nlohmann::json response;
        response["status"] = "stopped";
        response["runId"] = run_id;
        response["message"] = "Run was not active";
        return response;
    }

    nlohmann::json MetricsHelper::create_already_stopped_response(const std::string &run_id, const std::string &status)
    {
        nlohmann::json response;
        response["status"] = status;
        response["runId"] = run_id;
        response["message"] = "Run already " + status;
        return response;
    }

    bool MetricsHelper::wait_for_graceful_stop(vayu::core::RunContext &context, int timeout_seconds)
    {
        auto wait_start = std::chrono::steady_clock::now();

        while (context.is_running)
        {
            auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                               std::chrono::steady_clock::now() - wait_start)
                               .count();

            if (elapsed >= timeout_seconds)
            {
                return false; // Timeout
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        return true; // Stopped successfully
    }

} // namespace vayu::utils
