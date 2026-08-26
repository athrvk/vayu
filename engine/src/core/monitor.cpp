/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/monitor.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <set>
#include <string_view>

#include "vayu/db/database.hpp"

namespace vayu::core {

namespace {

/// Case-insensitive prefix test, for the scheme check (a URL may be typed
/// `HTTP://localhost:9100/metrics`).
bool starts_with_ci (const std::string& text, std::string_view prefix) {
    if (text.size () < prefix.size ()) {
        return false;
    }
    return std::equal (prefix.begin (), prefix.end (), text.begin (), [] (char a, char b) {
        return std::tolower (static_cast<unsigned char> (a)) ==
        std::tolower (static_cast<unsigned char> (b));
    });
}

/**
 * The one description of a `monitor` block: fills @p out and returns the reason
 * the block is unusable, or nullopt. Both public entry points go through here,
 * so the route's gate and the run's reader cannot disagree about a field.
 */
std::optional<std::string> read_monitor_block (const nlohmann::json& monitor,
const MonitorLimits& limits,
MonitorConfig& out) {
    // The configured cadence stands until the block names its own, so a user
    // who set `monitorIntervalMs` to 5000 gets 5000 for every run that does not
    // override it - including one started by a client that omits the field.
    out.interval_ms = limits.default_interval_ms;
    // The block has no timeout field of its own to override this: the scrape
    // budget is an engine setting because it is about the endpoint being
    // scraped, which is the same one run after run.
    out.scrape_timeout_ms = limits.scrape_timeout_ms;
    if (!monitor.is_object ()) {
        return "'monitor' must be an object with a 'url' and a 'series' list";
    }

    if (!monitor.contains ("url") || !monitor["url"].is_string ()) {
        return "'monitor.url' is required and must be a string";
    }
    out.url = monitor["url"].get<std::string> ();
    if (!starts_with_ci (out.url, "http://") && !starts_with_ci (out.url, "https://")) {
        // Loopback and private addresses are deliberately allowed: this is a
        // local tool scraping the user's own infrastructure, so the only thing
        // worth rejecting is a scheme the client cannot fetch at all.
        return "'monitor.url' must be an http:// or https:// URL (got \"" + out.url + "\")";
    }

    if (monitor.contains ("intervalMs") && !monitor["intervalMs"].is_null ()) {
        const auto& interval = monitor["intervalMs"];
        if (!interval.is_number ()) {
            return "'monitor.intervalMs' must be a number of milliseconds "
                   "(got " +
            std::string (interval.type_name ()) + ")";
        }
        const double value = interval.get<double> ();
        if (!(value >= monitor_limits::MIN_INTERVAL_MS) ||
        !(value <= monitor_limits::MAX_INTERVAL_MS)) {
            return "'monitor.intervalMs' must be between " +
            std::to_string (monitor_limits::MIN_INTERVAL_MS) + " and " +
            std::to_string (monitor_limits::MAX_INTERVAL_MS) +
            " - the scrape is one blocking request per interval, and a faster "
            "one measures the scraper rather than the target";
        }
        out.interval_ms = static_cast<int> (value);
    }

    if (monitor.contains ("format") && !monitor["format"].is_null ()) {
        if (!monitor["format"].is_string ()) {
            return "'monitor.format' must be \"prometheus\" or \"json\"";
        }
        const std::string format = monitor["format"].get<std::string> ();
        if (format == "prometheus") {
            out.format = MonitorFormat::Prometheus;
        } else if (format == "json") {
            out.format = MonitorFormat::Json;
        } else {
            return "'monitor.format' must be \"prometheus\" or \"json\" (got "
                   "\"" +
            format + "\")";
        }
    }

    if (!monitor.contains ("series") || !monitor["series"].is_array ()) {
        return "'monitor.series' is required and must be an array of metric "
               "names";
    }
    const auto& series = monitor["series"];
    if (series.empty ()) {
        return "'monitor.series' must name at least one metric - a scrape with "
               "nothing to read would record empty samples for the whole run";
    }
    if (series.size () > limits.max_series) {
        return "'monitor.series' may name at most " + std::to_string (limits.max_series) +
        " metrics (got " + std::to_string (series.size ()) +
        ") - raise 'monitorMaxSeries' in settings to chart more";
    }
    for (const auto& entry : series) {
        if (!entry.is_string () || entry.get<std::string> ().empty ()) {
            return "'monitor.series' entries must be non-empty metric names";
        }
        out.series.push_back (entry.get<std::string> ());
    }

    return std::nullopt;
}

/// The `monitor` value on a run config, or null when the run declared none.
const nlohmann::json& monitor_block (const nlohmann::json& config) {
    static const nlohmann::json absent = nlohmann::json ();
    if (!config.is_object () || !config.contains ("monitor")) {
        return absent;
    }
    return config["monitor"];
}

} // namespace

MonitorLimits read_monitor_limits (vayu::db::Database& db) {
    const MonitorLimits defaults;
    MonitorLimits limits;

    const int interval =
    db.get_config_int ("monitorIntervalMs", defaults.default_interval_ms);
    limits.default_interval_ms = (interval >= monitor_limits::MIN_INTERVAL_MS &&
                                 interval <= monitor_limits::MAX_INTERVAL_MS) ?
    interval :
    defaults.default_interval_ms;

    const int max_series =
    db.get_config_int ("monitorMaxSeries", static_cast<int> (defaults.max_series));
    limits.max_series =
    max_series > 0 ? static_cast<size_t> (max_series) : defaults.max_series;

    // A negative budget is not a shorter one, and a value past the longest
    // cadence the engine will scrape at could never be reached anyway - both
    // fall back to the derive sentinel rather than to a timeout the user did
    // not choose.
    const int scrape_timeout =
    db.get_config_int ("monitorScrapeTimeoutMs", defaults.scrape_timeout_ms);
    limits.scrape_timeout_ms =
    (scrape_timeout >= 0 && scrape_timeout <= monitor_limits::MAX_INTERVAL_MS) ?
    scrape_timeout :
    defaults.scrape_timeout_ms;

    return limits;
}

int resolve_scrape_timeout_ms (int interval_ms, int configured_timeout_ms) {
    if (configured_timeout_ms <= 0) {
        // Three quarters of the interval leaves room to store the row and come
        // back round.
        return std::max (
        monitor_limits::MIN_DERIVED_SCRAPE_TIMEOUT_MS, interval_ms * 3 / 4);
    }
    return std::min (configured_timeout_ms, interval_ms);
}

std::optional<std::string> validate_monitor_config (const nlohmann::json& config,
const MonitorLimits& limits) {
    const auto& monitor = monitor_block (config);
    if (monitor.is_null ()) {
        return std::nullopt;
    }
    MonitorConfig parsed;
    return read_monitor_block (monitor, limits, parsed);
}

std::optional<MonitorConfig>
monitor_config_from (const nlohmann::json& config, const MonitorLimits& limits) {
    const auto& monitor = monitor_block (config);
    if (monitor.is_null ()) {
        return std::nullopt;
    }
    MonitorConfig parsed;
    if (read_monitor_block (monitor, limits, parsed)) {
        return std::nullopt;
    }
    return parsed;
}

std::map<std::string, double> parse_prometheus_exposition (const std::string& body,
const std::vector<std::string>& series) {
    const std::set<std::string> wanted (series.begin (), series.end ());
    std::map<std::string, double> values;

    size_t line_start = 0;
    while (line_start <= body.size ()) {
        size_t line_end = body.find ('\n', line_start);
        if (line_end == std::string::npos) {
            line_end = body.size ();
        }
        std::string_view line =
        std::string_view (body).substr (line_start, line_end - line_start);
        line_start = line_end + 1;

        // Trim both ends: exposition files are frequently CRLF, and a trailing
        // '\r' would otherwise ride into the value token.
        while (!line.empty () &&
        std::isspace (static_cast<unsigned char> (line.front ()))) {
            line.remove_prefix (1);
        }
        while (!line.empty () && std::isspace (static_cast<unsigned char> (line.back ()))) {
            line.remove_suffix (1);
        }
        if (line.empty () || line.front () == '#') {
            continue;
        }

        const size_t name_end = line.find_first_of ("{ \t");
        if (name_end == std::string_view::npos) {
            continue; // a name with no value is not a sample
        }
        const std::string name (line.substr (0, name_end));
        if (wanted.find (name) == wanted.end ()) {
            continue;
        }

        size_t cursor = name_end;
        if (line[cursor] == '{') {
            // Scan to the closing brace, honouring quoted label values - a
            // label may legally contain '}' inside its quotes.
            bool in_quotes = false;
            bool escaped   = false;
            ++cursor;
            for (; cursor < line.size (); ++cursor) {
                const char ch = line[cursor];
                if (escaped) {
                    escaped = false;
                } else if (ch == '\\') {
                    escaped = true;
                } else if (ch == '"') {
                    in_quotes = !in_quotes;
                } else if (ch == '}' && !in_quotes) {
                    break;
                }
            }
            if (cursor >= line.size ()) {
                continue; // unterminated label set - not a sample this can read
            }
            ++cursor; // step over '}'
        }

        while (cursor < line.size () &&
        std::isspace (static_cast<unsigned char> (line[cursor]))) {
            ++cursor;
        }
        if (cursor >= line.size ()) {
            continue;
        }
        size_t value_end = cursor;
        while (value_end < line.size () &&
        !std::isspace (static_cast<unsigned char> (line[value_end]))) {
            ++value_end;
        }
        // A trailing exposition timestamp (the token after the value) is
        // deliberately ignored: the sample's time is when this engine scraped
        // it, which is the axis the overlay joins on.
        const std::string token (line.substr (cursor, value_end - cursor));
        try {
            size_t consumed  = 0;
            const double val = std::stod (token, &consumed);
            if (consumed != token.size () || !std::isfinite (val)) {
                continue; // NaN, +Inf, or trailing garbage
            }
            auto [it, inserted] = values.emplace (name, val);
            if (!inserted) {
                it->second += val; // one labelled family is one series
            }
        } catch (const std::exception&) {
            continue;
        }
    }

    return values;
}

std::map<std::string, double> parse_json_metrics (const std::string& body,
const std::vector<std::string>& series) {
    std::map<std::string, double> values;
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (body);
    } catch (const std::exception&) {
        return values;
    }
    if (!parsed.is_object ()) {
        return values;
    }
    for (const auto& name : series) {
        if (!parsed.contains (name) || !parsed[name].is_number ()) {
            continue;
        }
        const double value = parsed[name].get<double> ();
        if (std::isfinite (value)) {
            values[name] = value;
        }
    }
    return values;
}

std::map<std::string, double> parse_monitor_body (MonitorFormat format,
const std::string& body,
const std::vector<std::string>& series) {
    return format == MonitorFormat::Json ? parse_json_metrics (body, series) :
                                           parse_prometheus_exposition (body, series);
}

nlohmann::json build_monitor_sample_payload (int64_t timestamp,
const std::map<std::string, double>& values) {
    nlohmann::json series = nlohmann::json::object ();
    for (const auto& [name, value] : values) {
        series[name] = value;
    }
    nlohmann::json payload;
    payload["timestamp"] = timestamp;
    payload["series"]    = series;
    return payload;
}

void MonitorTotals::add (const std::map<std::string, double>& values) {
    ++samples_;
    for (const auto& [name, value] : values) {
        auto& acc = series_[name];
        if (acc.count == 0) {
            acc.min = value;
            acc.max = value;
        } else {
            acc.min = std::min (acc.min, value);
            acc.max = std::max (acc.max, value);
        }
        acc.sum += value;
        ++acc.count;
    }
}

void MonitorTotals::record_failure () {
    ++failures_;
}

nlohmann::json MonitorTotals::to_summary () const {
    nlohmann::json series = nlohmann::json::object ();
    for (const auto& [name, acc] : series_) {
        if (acc.count == 0) {
            continue;
        }
        series[name] = { { "min", acc.min }, { "max", acc.max },
            { "avg", acc.sum / static_cast<double> (acc.count) }, { "count", acc.count } };
    }
    nlohmann::json summary;
    summary["samples"]  = samples_;
    summary["failures"] = failures_;
    summary["series"]   = series;
    return summary;
}

} // namespace vayu::core
