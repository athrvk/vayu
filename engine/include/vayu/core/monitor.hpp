#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file monitor.hpp
 * @brief Pure core for a run's server-vitals monitor: what a `monitor` block
 *        may say, how a scraped body becomes numbers, and what the run reports
 *        about the whole scrape.
 *
 * A run knows everything about the client side and nothing about the target.
 * The monitor closes that gap by sampling a metrics endpoint the user already
 * exposes, on its own cadence, beside the run's own ticks.
 *
 * The halves live together for the same reason `threshold_eval.hpp`'s do:
 * `validate_monitor_config` (the route's gate) and `monitor_config_from` (what
 * the run actually executes) read one description of the block, so a field the
 * route accepts cannot be one the run silently ignores. Both are total over
 * arbitrary JSON - the route's copy is handed a client body, and the run's is
 * handed a stored config snapshot which may have been written by an older
 * engine or hand-edited.
 */

#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/core/constants.hpp"

namespace vayu::db {
// Only `read_monitor_limits` touches a database, and only by reference - the
// decision functions below hold none, which is what keeps them total over
// arbitrary JSON.
class Database;
} // namespace vayu::db

namespace vayu::core {

/** Which exposition format the scraped endpoint speaks. */
enum class MonitorFormat {
    /// Prometheus text exposition: `name{labels} value [timestamp]` lines.
    Prometheus,
    /// A flat JSON object of numbers, keyed by the requested series names.
    Json,
};

/// The bounds and seeds themselves live in `constants::monitor`, beside every
/// other tunable's; this is the local spelling.
namespace monitor_limits = constants::monitor;

/**
 * @brief The two limits a user can move, resolved from engine config.
 *
 * Passed in rather than read here so the functions below stay pure over
 * arbitrary JSON and hold no `Database` - the same split
 * `resolve_request_timeout_ms` draws in the execution route, where the caller
 * resolves the configured default and the decision function only takes a
 * number. The member defaults are the compile-time seeds, which is what lets a
 * test (or any caller without a database to hand) omit the argument entirely.
 */
struct MonitorLimits {
    /// Cadence for a block that names no `intervalMs` (`monitorIntervalMs`).
    int default_interval_ms = monitor_limits::DEFAULT_INTERVAL_MS;
    /// How many metric names one run may chart (`monitorMaxSeries`).
    size_t max_series = monitor_limits::MAX_SERIES;
};

/** A validated monitor block, ready for the scrape loop. */
struct MonitorConfig {
    std::string url;
    int interval_ms      = monitor_limits::DEFAULT_INTERVAL_MS;
    MonitorFormat format = MonitorFormat::Prometheus;
    std::vector<std::string> series;
};

/**
 * @brief Read the `monitorIntervalMs` / `monitorMaxSeries` settings, falling
 *        back to their compile-time seeds.
 *
 * One reader for both keys, so the route's gate and the run's own reader cannot
 * disagree about which limits are in force - the same reason
 * `read_auth_refresh_tuning` exists. A value outside the range `POST /config`
 * enforces can only come from a hand-edited row, and is discarded rather than
 * trusted: a zero interval is a tight scrape loop and a zero cap would reject
 * every block a user could write.
 */
[[nodiscard]] MonitorLimits read_monitor_limits (vayu::db::Database& db);

/**
 * @brief Reject a `monitor` block the run could not act on.
 *
 * Reads @p config (the whole run config) and looks only at its `monitor` key -
 * an absent or null one is valid, since monitoring is opt-in. Present means it
 * must be an object naming an http(s) URL and at least one series.
 *
 * @return The reason the block is unusable, or `std::nullopt`.
 */
[[nodiscard]] std::optional<std::string>
validate_monitor_config (const nlohmann::json& config, const MonitorLimits& limits = {});

/**
 * @brief The monitor block a run should execute, or `std::nullopt` for a run
 *        that configured none (or configured one this engine cannot read).
 *
 * Total over arbitrary JSON: it applies the same rules as
 * `validate_monitor_config` and returns nothing rather than throwing, so a
 * hand-edited snapshot yields "no monitor" instead of a dead run thread.
 */
[[nodiscard]] std::optional<MonitorConfig>
monitor_config_from (const nlohmann::json& config, const MonitorLimits& limits = {});

/**
 * @brief Pull the requested series out of one Prometheus exposition body.
 *
 * Comments (`#`) and blank lines are skipped, as is any line whose value is not
 * a finite number (`NaN`, `+Inf`, a trailing timestamp is ignored). **Samples
 * sharing a name across label sets are summed**: a labelled family
 * (`node_cpu_seconds_total{cpu="0",…}`) is one series here, because a chart of
 * the whole family is the reading the overlay exists to give.
 *
 * A name the body does not carry is absent from the result, never zero - "the
 * target stopped exporting it" and "it is zero" are different answers.
 */
[[nodiscard]] std::map<std::string, double>
parse_prometheus_exposition (const std::string& body, const std::vector<std::string>& series);

/**
 * @brief Pull the requested series out of a flat JSON object of numbers.
 *
 * A key that is absent, non-numeric or non-finite is skipped, for the same
 * reason the Prometheus parser skips one. A body that is not a JSON object
 * yields nothing rather than throwing.
 */
[[nodiscard]] std::map<std::string, double>
parse_json_metrics (const std::string& body, const std::vector<std::string>& series);

/// Dispatch to the parser @p format names.
[[nodiscard]] std::map<std::string, double> parse_monitor_body (MonitorFormat format,
const std::string& body,
const std::vector<std::string>& series);

/**
 * @brief The stored `monitor_samples.payload` object, returned verbatim as one
 *        `data[]` entry by `GET /runs/:id/monitor` and as the `data:` of a live
 *        `monitor` SSE frame.
 *
 * One shape for both, so the live overlay and the history overlay are drawn
 * from identical rows. The join onto the run's own timeline is by `timestamp`
 * (wall clock) rather than an elapsed offset, because the tick series measures
 * its elapsed seconds from the first *persisted* tick and the scrape loop
 * starts with the run.
 */
[[nodiscard]] nlohmann::json build_monitor_sample_payload (int64_t timestamp,
const std::map<std::string, double>& values);

/**
 * @brief Per-series min/max/avg over a whole run, plus what the scrape missed.
 *
 * Written by the monitor thread and read once the worker has joined it - the
 * join is the happens-before edge, exactly as it is for the metrics collector.
 */
class MonitorTotals {
    public:
    /// Fold one successful scrape in. A series absent from @p values is left
    /// untouched rather than counted as a zero sample.
    void add (const std::map<std::string, double>& values);
    /// Record a scrape that produced nothing (transport error, unreadable body).
    void record_failure ();

    [[nodiscard]] size_t samples () const {
        return samples_;
    }
    [[nodiscard]] size_t failures () const {
        return failures_;
    }

    /**
     * @brief The run report's `monitor` section, in its wire shape.
     *
     * `{"samples":n,"failures":n,"series":{"<name>":{"min","max","avg","count"}}}`.
     * A series that never produced a reading is absent, so the section never
     * claims a measurement that was not taken.
     */
    [[nodiscard]] nlohmann::json to_summary () const;

    private:
    struct Accumulator {
        double min   = 0.0;
        double max   = 0.0;
        double sum   = 0.0;
        size_t count = 0;
    };
    std::map<std::string, Accumulator> series_;
    size_t samples_  = 0;
    size_t failures_ = 0;
};

} // namespace vayu::core
