/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/metrics_helper.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <numeric>
#include <thread>

#include "vayu/core/constants.hpp"

namespace vayu::utils {

MetricsHelper::RunSummary MetricsHelper::calculate_summary (
const vayu::core::RunContext& context) {
    RunSummary summary;
    summary.total_requests = context.total_requests ();
    summary.errors         = context.total_errors ();
    summary.avg_latency_ms = context.average_latency_ms ();
    summary.error_rate     = summary.total_requests > 0 ?
        (static_cast<double> (summary.errors) * vayu::core::metrics::PERCENTAGE_MULTIPLIER /
    static_cast<double> (summary.total_requests)) :
        0.0;

    return summary;
}

namespace {

/** The per-phase timings summed across the results that carried them. */
struct TimingTotals {
    double dns        = 0;
    double connect    = 0;
    double tls        = 0;
    double first_byte = 0;
    double download   = 0;
    size_t samples    = 0;

    void apply_averages (DetailedReport& report) const {
        if (samples == 0) {
            return;
        }
        const auto n             = static_cast<double> (samples);
        report.avg_dns_ms        = dns / n;
        report.avg_connect_ms    = connect / n;
        report.avg_tls_ms        = tls / n;
        report.avg_first_byte_ms = first_byte / n;
        report.avg_download_ms   = download / n;
    }
};

/**
 * What one result's stored trace adds to the report: its error type, its phase
 * timings, and whether it was slow.
 *
 * One unreadable trace row contributes nothing and the run keeps counting - the
 * per-result counters are recorded by the caller, and a report that stopped at
 * the first bad row would describe fewer requests than the run made.
 */
void add_trace_metrics (const std::string& trace_data, DetailedReport& report, TimingTotals& timings) {
    if (trace_data.empty ()) {
        return;
    }
    try {
        auto trace = nlohmann::json::parse (trace_data);

        // Error details (supports both snake_case and camelCase)
        if (trace.contains ("error_type") || trace.contains ("errorType")) {
            report.errors_with_details++;
            std::string error_type = trace.contains ("error_type") ?
            trace["error_type"].get<std::string> () :
            trace["errorType"].get<std::string> ();
            report.error_types[error_type]++;
        }

        if (trace.contains ("dnsMs")) {
            report.has_timing_data = true;
            timings.samples++;
            timings.dns += trace["dnsMs"].get<double> ();
            timings.connect += trace["connectMs"].get<double> ();
            timings.tls += trace["tlsMs"].get<double> ();
            timings.first_byte += trace["firstByteMs"].get<double> ();
            timings.download += trace["downloadMs"].get<double> ();
        }

        if (trace.contains ("isSlow") && trace["isSlow"].get<bool> ()) {
            report.slow_requests_count++;
            if (trace.contains ("thresholdMs") && report.slow_threshold_ms == 0) {
                report.slow_threshold_ms = trace["thresholdMs"].get<size_t> ();
            }
        }
    } catch (const std::exception&) {
        // @deliberate: see the contract above - a bad row is skipped, not fatal.
    }
}

/** The latency distribution, from the sample this report was built from. */
void apply_latency_percentiles (std::vector<double>& latencies, DetailedReport& report) {
    if (latencies.empty ()) {
        return;
    }
    std::sort (latencies.begin (), latencies.end ());
    report.latency_min = latencies.front ();
    report.latency_max = latencies.back ();

    const auto percentile = [&latencies] (double p) {
        size_t idx =
        static_cast<size_t> (std::ceil (p * static_cast<double> (latencies.size ()))) - 1U;
        // Clamp index to valid range
        idx = std::max (size_t (0), std::min (idx, latencies.size () - 1));
        return latencies[idx];
    };

    report.latency_p50  = percentile (0.50);
    report.latency_p75  = percentile (0.75);
    report.latency_p90  = percentile (0.90);
    report.latency_p95  = percentile (0.95);
    report.latency_p99  = percentile (0.99);
    report.latency_p999 = percentile (0.999);
}

} // namespace

MetricsHelper::DetailedReport MetricsHelper::calculate_detailed_report (
const std::vector<vayu::db::Result>& results,
double duration_s) {
    DetailedReport report{};
    report.total_duration_s  = duration_s;
    report.has_timing_data   = false;
    report.slow_threshold_ms = 0;

    if (results.empty ()) {
        return report;
    }

    std::vector<double> latencies;
    latencies.reserve (results.size ());
    double total_latency = 0;

    TimingTotals timings;

    for (const auto& result : results) {
        report.total_requests++;
        report.status_codes[result.status_code]++;

        if (vayu::is_success_status (result.status_code)) {
            report.successful_requests++;
        } else {
            report.failed_requests++;
        }

        latencies.push_back (result.latency_ms);
        total_latency += result.latency_ms;

        add_trace_metrics (result.trace_data, report, timings);
    }

    // Calculate averages and rates
    report.error_rate = report.total_requests > 0 ?
    (static_cast<double> (report.failed_requests) * 100.0 /
    static_cast<double> (report.total_requests)) :
    0.0;

    report.avg_rps =
    duration_s > 0 ? static_cast<double> (report.total_requests) / duration_s : 0.0;
    report.latency_avg = report.total_requests > 0 ?
    total_latency / static_cast<double> (report.total_requests) :
    0.0;

    timings.apply_averages (report);
    apply_latency_percentiles (latencies, report);

    // Phase 1: Categorize errors by status code
    for (const auto& [code, count] : report.status_codes) {
        if (code == 0 || code >= 400) {
            report.errors_by_status_code[code] = count;
        }
    }

    // Phase 1: Set actual RPS (already calculated)
    report.actual_rps      = report.avg_rps;
    report.target_rps      = 0; // Will be set by caller if available
    report.rps_achievement = 0; // Will be calculated by caller

    return report;
}

nlohmann::json MetricsHelper::create_stop_response (const std::string& run_id,
const RunSummary& summary) {
    nlohmann::json response;
    response["status"]  = "stopped";
    response["runId"]   = run_id;
    response["summary"] = { { "totalRequests", summary.total_requests },
        { "errors", summary.errors }, { "errorRate", summary.error_rate },
        { "avgLatencyMs", summary.avg_latency_ms } };
    return response;
}

nlohmann::json MetricsHelper::create_inactive_response (const std::string& run_id) {
    nlohmann::json response;
    response["status"]  = "stopped";
    response["runId"]   = run_id;
    response["message"] = "Run was not active";
    return response;
}

nlohmann::json MetricsHelper::create_already_stopped_response (const std::string& run_id,
const std::string& status) {
    nlohmann::json response;
    response["status"]  = status;
    response["runId"]   = run_id;
    response["message"] = "Run already " + status;
    return response;
}

bool MetricsHelper::wait_for_graceful_stop (vayu::core::RunContext& context, int timeout_seconds) {
    auto wait_start = std::chrono::steady_clock::now ();

    while (context.is_running) {
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds> (
        std::chrono::steady_clock::now () - wait_start)
                       .count ();

        if (elapsed >= timeout_seconds) {
            return false; // Timeout
        }

        std::this_thread::sleep_for (std::chrono::milliseconds (100));
    }

    return true; // Stopped successfully
}

} // namespace vayu::utils
