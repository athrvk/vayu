#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <map>
#include <nlohmann/json.hpp>
#include <string>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

namespace vayu::utils {

/**
 * Helper class for calculating and formatting metrics from test runs.
 * Provides utility methods to compute summary statistics, format responses,
 * and handle metric aggregation logic.
 */
class MetricsHelper {
    public:
    using RunSummary     = vayu::RunSummary;
    using DetailedReport = vayu::DetailedReport;

    /**
     * Calculates summary metrics from an active run context.
     * @param context The active run context containing atomic counters.
     * @return RunSummary with computed metrics.
     */
    static RunSummary calculate_summary (const vayu::core::RunContext& context);

    /**
     * Calculates a detailed report from a list of results.
     * @param results The vector of results from the database.
     * @param duration_s The total duration of the test in seconds.
     * @return DetailedReport with computed statistics.
     */
    static DetailedReport
    calculate_detailed_report (const std::vector<vayu::db::Result>& results, double duration_s);

    /**
     * Creates a JSON response for a stopped run with summary metrics.
     * @param run_id The unique identifier of the run.
     * @param summary The computed summary metrics.
     * @return JSON object with status, runId, and summary.
     */
    static nlohmann::json
    create_stop_response (const std::string& run_id, const RunSummary& summary);

    /**
     * Creates a JSON response for an inactive run.
     * @param run_id The unique identifier of the run.
     * @return JSON object with status, runId, and message.
     */
    static nlohmann::json create_inactive_response (const std::string& run_id);

    /**
     * Creates a JSON response for a run that's already in a terminal state.
     * @param run_id The unique identifier of the run.
     * @param status The current status of the run (completed/stopped/failed).
     * @return JSON object with status, runId, and message.
     */
    static nlohmann::json create_already_stopped_response (const std::string& run_id,
    const std::string& status);

    /**
     * Waits for a run to stop gracefully with a timeout.
     * @param context The active run context to monitor.
     * @param timeout_seconds Maximum time to wait for graceful shutdown.
     * @return true if the run stopped within the timeout, false otherwise.
     */
    static bool wait_for_graceful_stop (vayu::core::RunContext& context,
    int timeout_seconds = 5);
};

} // namespace vayu::utils
