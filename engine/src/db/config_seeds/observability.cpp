/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "seed.hpp"

#include "vayu/core/constants.hpp"

#include <nlohmann/json.hpp>

#include <string>

namespace vayu::db::config_seeds {

namespace {
std::string log_level_options_json () {
    const nlohmann::json options = { { { "value", "debug" }, { "label", "Debug" } },
        { { "value", "info" }, { "label", "Info" } },
        { { "value", "warn" }, { "label", "Warning" } },
        { { "value", "error" }, { "label", "Error" } } };
    return options.dump ();
}
} // namespace

// =============================================================================
// OBSERVABILITY (observability)
// What a run measures and what the dashboard's live charts are fed: the
// server-vitals monitor, the live-metrics topic, and the per-phase timing
// histograms. What a run *stores* is Data & retention - the two were one
// category holding 24 of 48 entries until #586.
// =============================================================================
void seed_observability (ConfigSeeder& seed, int64_t now) {
    // Server-vitals monitor. All three are read per run - a change applies to
    // the next run started, no restart. The interval *bounds* (250-60000ms) are
    // deliberately not settings: they exist to stop a cadence that measures the
    // scraper rather than the target.
    seed (
    unit ("ms") (keywords ({ "prometheus" }) (ConfigEntry{ "monitorIntervalMs",
    std::to_string (vayu::core::constants::monitor::DEFAULT_INTERVAL_MS), "integer", "Server Monitoring Scrape Interval",
    "How often a load test scrapes the metrics endpoint it "
    "was pointed at, when the run does not set its own interval. Each scrape "
    "is "
    "one request on the run's monitor thread, so it never delays the run's own "
    "metrics - but a cadence faster than the target's own collection interval "
    "only re-reads the same numbers. Raise it for an endpoint that is "
    "expensive "
    "to render.",
    "observability", std::to_string (vayu::core::constants::monitor::DEFAULT_INTERVAL_MS),
    std::to_string (vayu::core::constants::monitor::MIN_INTERVAL_MS),
    std::to_string (vayu::core::constants::monitor::MAX_INTERVAL_MS), std::nullopt, now })));

    seed (keywords ({ "prometheus" }) (ConfigEntry{ "monitorMaxSeries",
    std::to_string (vayu::core::constants::monitor::MAX_SERIES), "integer", "Server Monitoring Metric Limit",
    "How many metric names one run may chart from its monitored endpoint. Each "
    "is a line on a single overlay and a name matched against every line of "
    "the "
    "exposition body, so the ceiling is about a readable chart rather than a "
    "hard cost. The chart has four distinct colours and repeats them past "
    "that.",
    "observability", std::to_string (vayu::core::constants::monitor::MAX_SERIES),
    "1", "64", std::nullopt, now }));

    seed (advanced (unit ("ms") (
    keywords ({ "prometheus" }) (ConfigEntry{ "monitorScrapeTimeoutMs",
    std::to_string (vayu::core::constants::monitor::DEFAULT_SCRAPE_TIMEOUT_MS), "integer", "Server Monitoring Scrape Timeout",
    "How long one scrape of the metrics endpoint may take "
    "before it counts as a gap in the series. 0 derives the budget from the "
    "scrape interval - three quarters of it - which is what most endpoints "
    "want; set it explicitly for an exposition slow enough to fail every "
    "scrape "
    "at that budget, where the only other way out is a slower cadence that "
    "also "
    "thins the data. A value longer than the interval a run scrapes at is "
    "shortened to it, because a scrape that outlives its own cadence puts the "
    "loop behind itself.",
    "observability", std::to_string (vayu::core::constants::monitor::DEFAULT_SCRAPE_TIMEOUT_MS),
    "0", std::to_string (vayu::core::constants::monitor::MAX_INTERVAL_MS),
    std::nullopt, now }))));

    seed (unit ("ms") (
    keywords ({ "refresh rate", "sse" }) (ConfigEntry{ "liveTickIntervalMs",
    std::to_string (vayu::core::constants::server::STATS_INTERVAL_MS), "integer", "Live Metrics Tick Interval",
    "How often the engine emits a live-metrics tick into the "
    "in-memory replay topic during a run. A lower value gives smoother live "
    "charts for slightly more CPU; the 1-second ceiling exists because slower "
    "ticks defeat live smoothness. The historical 1 Hz database sampling is "
    "unaffected.",
    "observability", std::to_string (vayu::core::constants::server::STATS_INTERVAL_MS),
    "10", "1000", std::nullopt, now })));

    seed (
    unit ("ms") (keywords ({ "time range" }) (ConfigEntry{ "liveReplayWindowMs",
    std::to_string (vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS), "integer", "Live Chart Window",
    "How much recent live-metrics history to keep: the span the dashboard's "
    "live "
    "charts show, and the span the engine holds in memory per run so the "
    "dashboard can rebuild those charts when it attaches - or re-attaches - "
    "mid-run. One setting drives both, so they cannot disagree. Its editor is "
    "Settings > Dashboard > Chart window, which is where the effect is "
    "visible; this list deliberately does not offer a second one. Expressed "
    "as elapsed time "
    "rather than a tick count, so it survives a change to the tick interval. 0 "
    "means the full run (no time limit). Live Metrics Tick Ceiling is the "
    "memory backstop "
    "either way, so a fast tick interval reaches that ceiling before a long "
    "window does.",
    "observability", std::to_string (vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS),
    "0", "3600000", std::nullopt, now })));

    seed (advanced (ConfigEntry{ "liveMaxRetainedTicks",
    std::to_string (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS), "integer", "Live Metrics Tick Ceiling",
    "Hard ceiling on live-metrics data points held in memory per run, on both "
    "sides - the engine's replay ring and the dashboard's chart history. It is "
    "a memory bound rather than a rendering one, since the charts bucket "
    "points "
    "before plotting, and it binds only when the chart window divided by the "
    "tick interval exceeds it - a long window at a fast tick interval, which "
    "stock settings never reach. Raise it if a long window is being cut short; "
    "each point costs roughly 1 KB.",
    "observability", std::to_string (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS),
    "1000", "500000", std::nullopt, now }));

    seed (unit ("ms") (ConfigEntry{ "liveRetentionMs", "60000", "integer", "Live Metrics Retention",
    "How long a finished run's in-memory live-metrics topic "
    "is kept so the dashboard can still attach and replay it. After this "
    "window "
    "the run is evicted and the dashboard falls back to the stored report. 0 "
    "disables retention, so that fallback is immediate.",
    "observability", "60000", "0", "600000", std::nullopt, now }));

    seed (restart_required (keywords ({ "verbosity", "logging" }) (ConfigEntry{ "logLevel",
    vayu::core::constants::logging::DEFAULT_LEVEL, "enum", "Engine Log Level",
    "The lowest severity the engine writes to its log file. Debug records "
    "everything, which is what a bug report wants and what fills a disk "
    "fastest; "
    "Warning and Error keep a long-running install quiet. The console is "
    "separate - it follows the daemon's -v flag, so raising this does not "
    "silence a terminal you started the engine in.",
    "observability", vayu::core::constants::logging::DEFAULT_LEVEL,
    std::nullopt, std::nullopt, log_level_options_json (), now })));

    seed (advanced (restart_required (unit ("bytes") (
    keywords ({ "rotation", "retention" }) (ConfigEntry{ "maxLogFileBytes",
    std::to_string (vayu::core::constants::logging::DEFAULT_MAX_FILE_BYTES), "integer", "Max Log File Size",
    "How large one log file may grow before it is rotated once to a '.1' "
    "beside it and writing continues in a fresh one. A start already gets its "
    "own file, and the newest " +
    std::to_string (vayu::core::constants::logging::RETAINED_FILES) +
    " of those are what the log directory keeps, so this bounds the one case "
    "that naming cannot: a single run chatty enough to fill the disk by "
    "itself. 0 removes the bound.",
    "observability", std::to_string (vayu::core::constants::logging::DEFAULT_MAX_FILE_BYTES),
    "0", "1073741824", std::nullopt, now })))));

    seed (keywords ({ "ttfb", "timings" }) (ConfigEntry{
    "phaseHistograms", vayu::core::constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS ? "true" : "false",
    "boolean", "Per-Phase Latency Histograms",
    "Records DNS, connect, TLS, first-byte and download times for every "
    "load-test completion, so the report gives each phase real percentiles "
    "instead of an average over the few exchanges it stores traces for. This "
    "is "
    "what answers whether a slow p99 came from the server or from connection "
    "setup. It costs five histogram writes per completion; turn it off only if "
    "a run at your throughput ceiling measurably suffers.",
    "observability", vayu::core::constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS ? "true" : "false",
    std::nullopt, std::nullopt, std::nullopt, now }));
}

} // namespace vayu::db::config_seeds
