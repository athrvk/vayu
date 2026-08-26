#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

struct RunContext; // Forward declaration

/**
 * @brief Closed-loop concurrency controller. Seeds target(0), then refills the
 * in-flight deficit toward target(t) - woken per completion via refill_cv with
 * a 50ms safety-net timeout (drives ramp growth + bounds stop latency).
 *
 * Shared by the single-request strategies and the scenario load executor, which
 * differ only in what @p submit_one submits: "another copy of the one request"
 * versus "the next step of virtual user *k*". Every other property - the
 * single-producer discipline, the pure `compute_refill_deficit`, the SPSC
 * submission path - is the same for both, so there is deliberately one copy of
 * this loop rather than one per executor.
 *
 * @param submit_one   submits exactly one request and increments requests_sent
 * @param target_fn    desired in-flight at elapsed_ms
 * @param budget_fn    remaining submission budget (SIZE_MAX for time-bounded)
 * @param should_continue  whether to keep refilling at elapsed_ms
 */
void maintain_concurrency (std::shared_ptr<RunContext> context,
const std::function<void ()>& submit_one,
const std::function<size_t (int64_t)>& target_fn,
const std::function<size_t ()>& budget_fn,
const std::function<bool (int64_t)>& should_continue);

/**
 * @brief Read a run-config duration field ("30s", "500ms", "5m", "2h") as
 *        milliseconds; @p default_ms when the key is absent or null.
 *
 * A JSON number is read as seconds. Anything else - an unknown unit, a
 * non-numeric string, a negative - throws `std::invalid_argument`, which the
 * run thread's caller turns into a Failed run naming the value. The old parser
 * silently ran for 60s instead, so a mistyped duration looked like a run that
 * simply took longer; every executor reads durations through here so none can
 * reintroduce that.
 */
[[nodiscard]] int64_t
duration_field_ms (const nlohmann::json& config, const std::string& key, int64_t default_ms);

/**
 * @brief Facts about a completion that only the executor knows, attached to
 *        whatever record the completion produces.
 *
 * A scenario load run binds a data row per iteration (issue #449); without the
 * row on the record, a failure is unattributable - "which row produced this
 * 400" is the question a data-driven run exists to answer. A struct rather than
 * a parameter, so a second such fact does not move every call site again.
 */
struct ResultAnnotations {
    /// Absent for every single-request run, and for a scenario run sent without
    /// `data` - the record then carries no `dataRowIndex` at all rather than a
    /// zero that reads like row 0.
    std::optional<size_t> data_row_index;
    /**
     * The plan step this completion belongs to, and the virtual user's
     * iteration it ran in. Set by the scenario load executor and by nothing
     * else, so their presence *is* how `handle_result` tells a scenario
     * completion from a single-request one - which is what routes the response
     * to the step's own sample reservoir instead of the run's (issue #450).
     */
    std::optional<size_t> step_index;
    std::optional<size_t> iteration;
};

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
 * @param annotations Reaches the stored record only where one is stored: an
 *           unsampled success keeps no trace, so there is nothing to annotate.
 */
void handle_result (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const vayu::Result<vayu::Response>& result,
const ResultAnnotations& annotations = {});

/**
 * @brief Interface for load testing strategies
 */
class LoadStrategy {
    public:
    LoadStrategy ()          = default;
    virtual ~LoadStrategy () = default;
    // Deleted rather than protected: nothing copies a strategy - they are held
    // by pointer and run in place - and deleting is what stops a derived one
    // being sliced back to this interface.
    LoadStrategy (const LoadStrategy&)            = delete;
    LoadStrategy& operator= (const LoadStrategy&) = delete;
    LoadStrategy (LoadStrategy&&)                 = delete;
    LoadStrategy& operator= (LoadStrategy&&)      = delete;

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
