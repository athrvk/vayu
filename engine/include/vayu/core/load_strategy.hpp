#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

struct RunContext; // Forward declaration

/**
 * @brief Record a completed transfer into the run's in-memory MetricsCollector.
 *
 * Every completion - success, a Response carrying a client-side error, and a
 * transport-level Error alike - must land here: the collector's counters are
 * what drive in_flight() accounting and the closed-loop refill wakeup, so a
 * dropped completion is a permanently leaked in-flight slot.
 *
 * Declared here (rather than kept file-local) so the failure paths can be
 * tested directly; production callers are the strategies in load_strategy.cpp.
 *
 * @param db Unused, kept for API compatibility - metrics are batch-written
 *           to the database after the run completes, not from here.
 */
void handle_result (std::shared_ptr<RunContext> context,
vayu::db::Database& db,
vayu::Result<vayu::Response> result);

/**
 * @brief Interface for load testing strategies
 */
class LoadStrategy {
    public:
    virtual ~LoadStrategy () = default;

    /**
     * @brief Execute the load test strategy
     * @param context The run context
     * @param db Database for storing results
     * @param request The request to execute
     */
    virtual void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) = 0;

    /**
     * @brief Create a strategy instance based on configuration
     */
    static std::unique_ptr<LoadStrategy> create (const nlohmann::json& config);
};

} // namespace vayu::core
