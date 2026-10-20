/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export.cpp
 * @brief The run-report document (#2127): an allowlisted copy of a finished
 *        load run's report, configuration and time series.
 */

#include "vayu/core/run_export.hpp"

#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/postman_export.hpp"
#include "vayu/core/run_compare.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/utils/reentrant.hpp"

#include <algorithm>
#include <array>
#include <ctime>
#include <span>
#include <string>
#include <string_view>
#include <utility>

namespace vayu::core {

namespace {

using json    = nlohmann::json;
using ordered = nlohmann::ordered_json;
using Keys    = std::span<const std::string_view>;

/// What `Copy for agent` calls a request that was never named (the app's
/// `DEFAULT_REQUEST_NAME`); such a name says nothing, so the target does.
constexpr std::string_view DEFAULT_REQUEST_NAME = "New Request";

bool is_scalar (const json& value) {
    return value.is_primitive ();
}

/// A value `pick` copies as it stands: a scalar, or a list of scalars. Any
/// deeper structure is named member by member, so nothing nested rides along
/// unread.
bool is_leaf (const json& value) {
    return is_scalar (value) ||
    (value.is_array () && std::ranges::all_of (value, is_scalar));
}

/// The members of @p source named in @p keys, in that order, each kept only
/// when it is present and a leaf.
ordered pick (const json& source, Keys keys) {
    ordered out = ordered::object ();
    if (!source.is_object ()) {
        return out;
    }
    for (const std::string_view key : keys) {
        const auto found = source.find (key);
        if (found != source.end () && is_leaf (*found)) {
            out[std::string (key)] = *found;
        }
    }
    return out;
}

/// @ref pick over each object of an array.
ordered pick_each (const json& source, Keys keys) {
    ordered out = ordered::array ();
    if (!source.is_array ()) {
        return out;
    }
    for (const json& entry : source) {
        out.push_back (pick (entry, keys));
    }
    return out;
}

/// `{name: {...}}` with each entry @ref pick ed: the map's keys are names a
/// user or the engine chose (a custom metric, a scraped series).
ordered pick_named (const json& source, Keys keys) {
    ordered out = ordered::object ();
    if (!source.is_object ()) {
        return out;
    }
    for (const auto& [name, entry] : source.items ()) {
        out[name] = pick (entry, keys);
    }
    return out;
}

/// `{name: count}`, numbers only.
ordered count_map (const json& source) {
    ordered out = ordered::object ();
    if (!source.is_object ()) {
        return out;
    }
    for (const auto& [name, count] : source.items ()) {
        if (count.is_number ()) {
            out[name] = count;
        }
    }
    return out;
}

/// A status-code distribution as `{"200": count}`. The report serialises a
/// `std::map<int, size_t>`, which nlohmann writes as `[[code, count], ...]`
/// pairs; an object (a stored summary's shape) is read as well.
ordered code_counts (const json& source) {
    if (source.is_object ()) {
        return count_map (source);
    }
    ordered out = ordered::object ();
    if (!source.is_array ()) {
        return out;
    }
    for (const json& pair : source) {
        if (pair.is_array () && pair.size () == 2 &&
        pair[0].is_number_integer () && pair[1].is_number ()) {
            out[std::to_string (pair[0].get<int64_t> ())] = pair[1];
        }
    }
    return out;
}

/// @p key of @p source as a string, or @p fallback.
std::string
string_member (const json& source, std::string_view key, std::string_view fallback = {}) {
    if (!source.is_object ()) {
        return std::string (fallback);
    }
    const auto found = source.find (key);
    return found != source.end () && found->is_string () ? found->get<std::string> () :
                                                           std::string (fallback);
}

/// @p key of @p source as a string, or JSON null.
ordered string_or_null (const json& source, std::string_view key) {
    if (!source.is_object ()) {
        return nullptr;
    }
    const auto found = source.find (key);
    return found != source.end () && found->is_string () ? ordered (*found) : ordered ();
}

const json& member (const json& source, std::string_view key) {
    static const json absent;
    if (!source.is_object ()) {
        return absent;
    }
    const auto found = source.find (key);
    return found == source.end () ? absent : *found;
}

// --- report sections ---------------------------------------------------------

constexpr auto SUMMARY_KEYS = std::to_array<std::string_view> (
{ "totalRequests", "successfulRequests", "failedRequests", "httpErrorRequests",
"noResponseRequests", "cancelledRequests", "errorRate", "totalDurationSeconds",
"avgRps", "testDuration", "sendRate", "throughput", "setupOverhead",
"peakConcurrency", "droppedRequests", "avgQueueWaitMs", "bytesSent", "bytesReceived",
"httpVersionDowngraded", "throughputBytesPerSec", "sendingDurationSeconds" });
constexpr auto LATENCY_KEYS = std::to_array<std::string_view> (
{ "min", "max", "avg", "median", "p50", "p75", "p90", "p95", "p99", "p999" });
constexpr auto RATE_CONTROL_KEYS = std::to_array<std::string_view> (
{ "targetRps", "actualRps", "achievement", "requestsSent", "requestsExpected" });
constexpr auto ERRORS_KEYS = std::to_array<std::string_view> ({ "total", "withDetails" });
constexpr auto TIMING_AVERAGE_KEYS = std::to_array<std::string_view> (
{ "avgDnsMs", "avgConnectMs", "avgTlsMs", "avgFirstByteMs", "avgDownloadMs" });
constexpr auto PHASE_KEYS =
std::to_array<std::string_view> ({ "p50", "p95", "p99", "max", "count" });
constexpr auto STREAM_KEYS = std::to_array<std::string_view> (
{ "completions", "totalEvents", "capped", "eventsPerSecond" });
constexpr auto STREAM_EVENTS_KEYS = std::to_array<std::string_view> (
{ "min", "max", "p50", "p90", "p95", "p99", "count" });
constexpr auto SLOW_REQUESTS_KEYS =
std::to_array<std::string_view> ({ "count", "thresholdMs", "percentage" });
constexpr auto SAMPLING_KEYS =
std::to_array<std::string_view> ({ "errorsDropped", "successTracesDropped",
"slowTracesDropped", "responseSamplesDropped", "exemplarsDropped",
"sampleBodiesDropped", "responseBodiesCaptured", "responseSampleBudgetSpent" });
constexpr auto WARNING_KEYS =
std::to_array<std::string_view> ({ "code", "message", "count", "names", "steps" });
constexpr auto SCENARIO_KEYS = std::to_array<std::string_view> ({ "iterations",
"iterationsCompleted", "stepsExecuted", "passed", "failed", "skipped", "errored",
"stepsStored", "stepsDropped", "virtualUsers", "iterationsAbandoned" });
constexpr auto STEP_KEYS =
std::to_array<std::string_view> ({ "index", "name", "requestId", "method", "executed",
"errors", "httpErrors", "noResponse", "unresolvedTokens", "preRequestScript" });
constexpr auto STEP_LATENCY_KEYS =
std::to_array<std::string_view> ({ "min", "p50", "p95", "p99", "max" });
constexpr auto ELEMENT_TALLY_KEYS = std::to_array<std::string_view> (
{ "id", "kind", "passed", "failed", "skipped", "deferred" });
constexpr auto TRANSACTION_KEYS =
std::to_array<std::string_view> ({ "name", "count", "errors" });
constexpr auto TRANSACTION_LATENCY_KEYS =
std::to_array<std::string_view> ({ "min", "p50", "p90", "p95", "p99", "max" });
constexpr auto MONITOR_KEYS = std::to_array<std::string_view> ({ "samples", "failures" });
constexpr auto MONITOR_SERIES_KEYS =
std::to_array<std::string_view> ({ "min", "max", "avg", "count" });
constexpr auto TEST_VALIDATION_KEYS = std::to_array<std::string_view> (
{ "samplesTested", "testsPassed", "testsFailed", "successRate" });
constexpr auto CAPACITY_KEYS =
std::to_array<std::string_view> ({ "sloMs", "stopReason", "maxHealthyConcurrency",
"maxHealthyRps", "p99AtMaxHealthyMs", "kneeConcurrency", "kneeP99Ms" });
constexpr auto CAPACITY_LEVEL_KEYS =
std::to_array<std::string_view> ({ "concurrency", "rps", "p99Ms" });
constexpr auto COVERAGE_KEYS =
std::to_array<std::string_view> ({ "operationsTotal", "operationsCovered",
"declaredResponsesTotal", "declaredResponsesHit", "declaredResponseCoveragePct",
"undeclaredStatusesSeen", "transportErrors", "undeclaredOperationRequests" });
constexpr auto COVERAGE_OPERATION_KEYS = std::to_array<std::string_view> (
{ "operationId", "method", "path", "sent", "statusesSeen", "declaredHit", "declaredMissed",
"undeclaredSeen", "transportErrors", "otherStatusResponses", "statusesTruncated" });
// `failures[]` is left behind: each carries a validator message about a
// response body. `failuresTotal` keeps the count.
constexpr auto SCHEMA_VALIDATION_KEYS =
std::to_array<std::string_view> ({ "sampled", "checked", "valid", "failed",
"unevaluated", "failuresTotal", "exact", "failOnSchemaError" });
constexpr auto KEYWORD_COUNT_KEYS =
std::to_array<std::string_view> ({ "keyword", "count" });
// `message` is left behind: it is what a setup or teardown script threw.
constexpr auto LIFECYCLE_OUTCOME_KEYS =
std::to_array<std::string_view> ({ "id", "kind", "outcome", "waitedMs" });
constexpr auto THRESHOLD_KEYS =
std::to_array<std::string_view> ({ "passed", "failed", "verdict" });
constexpr auto THRESHOLD_CHECK_KEYS = std::to_array<std::string_view> (
{ "metric", "limit", "actual", "passed", "evaluated" });
constexpr auto CUSTOM_METRIC_KEYS = std::to_array<std::string_view> (
{ "type", "count", "p50", "p95", "p99", "max", "value" });

ordered errors_section (const json& errors) {
    ordered out  = pick (errors, ERRORS_KEYS);
    out["types"] = count_map (member (errors, "types"));
    if (const json& by_status = member (errors, "byStatusCode"); !by_status.is_null ()) {
        out["byStatusCode"] = code_counts (by_status);
    }
    return out;
}

ordered timing_section (const json& timing) {
    ordered out        = pick (timing, TIMING_AVERAGE_KEYS);
    const json& phases = member (timing, "phases");
    if (!phases.is_object ()) {
        return out;
    }
    ordered picked = ordered::object ();
    for (const char* phase : TIMING_PHASE_KEYS) {
        if (phases.contains (phase)) {
            picked[phase] = pick (phases[phase], PHASE_KEYS);
        }
    }
    out["phases"] = std::move (picked);
    return out;
}

ordered stream_section (const json& stream) {
    ordered out = pick (stream, STREAM_KEYS);
    if (const json& events = member (stream, "events"); events.is_object ()) {
        out["events"] = pick (events, STREAM_EVENTS_KEYS);
    }
    return out;
}

ordered scenario_step (const json& step) {
    ordered out = pick (step, STEP_KEYS);
    if (const json& latency = member (step, "latency"); latency.is_object ()) {
        out["latency"] = pick (latency, STEP_LATENCY_KEYS);
    }
    if (const json& elements = member (step, "elements"); elements.is_array ()) {
        out["elements"] = pick_each (elements, ELEMENT_TALLY_KEYS);
    }
    return out;
}

ordered scenario_transaction (const json& transaction) {
    ordered out = pick (transaction, TRANSACTION_KEYS);
    if (const json& latency = member (transaction, "latency"); latency.is_object ()) {
        out["latency"] = pick (latency, TRANSACTION_LATENCY_KEYS);
    }
    return out;
}

ordered scenario_section (const json& scenario) {
    ordered out = pick (scenario, SCENARIO_KEYS);
    if (const json& steps = member (scenario, "steps"); steps.is_array ()) {
        ordered picked = ordered::array ();
        for (const json& step : steps) {
            picked.push_back (scenario_step (step));
        }
        out["steps"] = std::move (picked);
    }
    if (const json& transactions = member (scenario, "transactions");
    transactions.is_array ()) {
        ordered picked = ordered::array ();
        for (const json& transaction : transactions) {
            picked.push_back (scenario_transaction (transaction));
        }
        out["transactions"] = std::move (picked);
    }
    return out;
}

ordered monitor_section (const json& monitor) {
    ordered out = pick (monitor, MONITOR_KEYS);
    out["series"] = pick_named (member (monitor, "series"), MONITOR_SERIES_KEYS);
    return out;
}

ordered capacity_section (const json& capacity) {
    ordered out = pick (capacity, CAPACITY_KEYS);
    out["levels"] = pick_each (member (capacity, "levels"), CAPACITY_LEVEL_KEYS);
    return out;
}

ordered coverage_section (const json& coverage) {
    ordered out = pick (coverage, COVERAGE_KEYS);
    out["operations"] = pick_each (member (coverage, "operations"), COVERAGE_OPERATION_KEYS);
    return out;
}

ordered schema_validation_section (const json& validation) {
    ordered out = pick (validation, SCHEMA_VALIDATION_KEYS);
    if (const json& reasons = member (validation, "uncheckedReasons"); reasons.is_object ()) {
        out["uncheckedReasons"] = count_map (reasons);
    }
    if (const json& keywords = member (validation, "unevaluatedKeywords");
    keywords.is_array ()) {
        out["unevaluatedKeywords"] = pick_each (keywords, KEYWORD_COUNT_KEYS);
    }
    return out;
}

ordered lifecycle_section (const json& lifecycle) {
    ordered out = ordered::object ();
    for (const char* phase : { "setup", "teardown" }) {
        if (const json& outcomes = member (lifecycle, phase); outcomes.is_array ()) {
            out[phase] = pick_each (outcomes, LIFECYCLE_OUTCOME_KEYS);
        }
    }
    return out;
}

ordered threshold_section (const json& thresholds) {
    ordered out = ordered::object ();
    out["checks"] = pick_each (member (thresholds, "checks"), THRESHOLD_CHECK_KEYS);
    out.update (pick (thresholds, THRESHOLD_KEYS));
    return out;
}

using SectionBuilder = ordered (*) (const json&);

struct ReportSection {
    std::string_view key;
    SectionBuilder build;
};

/// Every report section the document carries, in the order it writes them.
/// A section the report does not hold stays absent, as the report has it.
constexpr auto REPORT_SECTIONS = std::to_array<ReportSection> ({
{ "summary", [] (const json& s) { return pick (s, SUMMARY_KEYS); } },
{ "latency", [] (const json& s) { return pick (s, LATENCY_KEYS); } },
{ "statusCodes", code_counts },
{ "rateControl", [] (const json& s) { return pick (s, RATE_CONTROL_KEYS); } },
{ "errors", errors_section },
{ "timingBreakdown", timing_section },
{ "stream", stream_section },
{ "slowRequests", [] (const json& s) { return pick (s, SLOW_REQUESTS_KEYS); } },
{ "sampling", [] (const json& s) { return pick (s, SAMPLING_KEYS); } },
{ "warnings", [] (const json& s) { return pick_each (s, WARNING_KEYS); } },
{ "scenario", scenario_section },
{ "monitor", monitor_section },
{ "testValidation", [] (const json& s) { return pick (s, TEST_VALIDATION_KEYS); } },
{ "capacity", capacity_section },
{ "coverage", coverage_section },
{ "schemaValidation", schema_validation_section },
{ "lifecycle", lifecycle_section },
{ "elements", [] (const json& s) { return pick_each (s, ELEMENT_TALLY_KEYS); } },
{ "thresholdValidation", threshold_section },
{ "customMetrics",
[] (const json& s) { return pick_named (s, CUSTOM_METRIC_KEYS); } },
});

ordered report_section (const json& report) {
    ordered out = ordered::object ();
    for (const ReportSection& section : REPORT_SECTIONS) {
        const json& source = member (report, section.key);
        if (!source.is_null ()) {
            out[std::string (section.key)] = section.build (source);
        }
    }
    return out;
}

// --- config ------------------------------------------------------------------

constexpr auto CONFIGURATION_KEYS = std::to_array<std::string_view> ({ "mode",
"duration", "concurrency", "startConcurrency", "rampUpDuration", "timeout", "targetRps",
"comment", "followRedirects", "maxRedirects", "httpVersion", "acceptEncoding",
"expectContinue", "dataRowCount", "dataFileName", "dataFileHash", "carriedBudgets" });

/// The names of a payload's headers or Params rows: an object's keys, or each
/// row's `key` - a header line's `name` (issue #2466). Values never.
ordered names_of (const json& rows) {
    ordered names = ordered::array ();
    if (rows.is_object ()) {
        for (const auto& [name, value] : rows.items ()) {
            names.push_back (name);
        }
    } else if (rows.is_array ()) {
        for (const json& row : rows) {
            const json& key = member (row, "key");
            if (const json& name = key.is_string () ? key : member (row, "name");
            name.is_string ()) {
                names.push_back (name.get<std::string> ());
            }
        }
    }
    return names;
}

/// `{mode, bytes}`: the size of the body text as stored (its size before the
/// snapshot cap when the cap cut it), `null` for a body that is not text.
ordered body_shape (const json& body) {
    ordered out = { { "mode", string_member (body, "mode", "none") }, { "bytes", nullptr } };
    if (const json& stated = member (body, "bodyBytes"); stated.is_number_integer ()) {
        out["bytes"] = stated;
    } else if (const json& content = member (body, "content"); content.is_string ()) {
        out["bytes"] = content.get_ref<const std::string&> ().size ();
    }
    return out;
}

ordered config_section (const json& snapshot, const json& report, int& url_omitted) {
    ordered url = nullptr;
    if (const json& stored = member (snapshot, "url"); stored.is_string ()) {
        const auto api_key_params =
        vayu_ext::apikey_param_names (vayu_ext::Json (member (snapshot, "auth")));
        url = vayu_ext::redact_url_credentials (
        stored.get_ref<const std::string&> (), api_key_params, url_omitted);
    }
    ordered config        = ordered::object ();
    config["method"]      = string_or_null (snapshot, "method");
    config["url"]         = std::move (url);
    config["headerNames"] = names_of (member (snapshot, "headers"));
    config["paramNames"]  = names_of (member (snapshot, "params"));
    config["body"]        = body_shape (member (snapshot, "body"));
    config["auth"] = { { "mode", string_member (member (snapshot, "auth"), "mode", "none") } };
    config["configuration"] =
    pick (member (member (report, "metadata"), "configuration"), CONFIGURATION_KEYS);
    return config;
}

// --- run identity --------------------------------------------------------------

/// A name as it sits between a reference line's double quotes: `\` and `"`
/// escaped, each run of line breaks (CR, LF, U+2028, U+2029) one space - the
/// app's `quoteName`, so a name never ends its quotes or starts a second line.
std::string quote_name (std::string_view name) {
    constexpr std::string_view LINE_SEPARATOR      = "\xE2\x80\xA8";
    constexpr std::string_view PARAGRAPH_SEPARATOR = "\xE2\x80\xA9";
    std::string out;
    bool in_break = false;
    for (std::size_t at = 0; at < name.size ();) {
        const std::string_view rest = name.substr (at);
        const bool wide_break       = rest.starts_with (LINE_SEPARATOR) ||
        rest.starts_with (PARAGRAPH_SEPARATOR);
        if (wide_break || rest.front () == '\r' || rest.front () == '\n') {
            if (!in_break) {
                out += ' ';
            }
            in_break = true;
            at += wide_break ? LINE_SEPARATOR.size () : 1;
            continue;
        }
        in_break = false;
        if (rest.front () == '\\' || rest.front () == '"') {
            out += '\\';
        }
        out += rest.front ();
        ++at;
    }
    return out;
}

/// The path of @p url with no scheme, authority, query or fragment; a URL
/// that names no path is `/`. A reference never carries a query string.
std::string url_path (std::string_view url) {
    if (const auto scheme = url.find ("://"); scheme != std::string_view::npos) {
        const auto path = url.find_first_of ("/?#", scheme + 3);
        url = path == std::string_view::npos ? std::string_view () : url.substr (path);
    }
    url              = url.substr (0, url.find_first_of ("?#"));
    std::string path = url.empty () ? std::string ("/") : std::string (url);
    std::ranges::replace (path, '\r', ' ');
    std::ranges::replace (path, '\n', ' ');
    return path;
}

/// What the run sent to: `collection "<name>"` for a collection load run,
/// otherwise `<METHOD> <path>`.
std::string run_target (const RunExportRun& run) {
    const json& scenario = member (run.config_snapshot, "scenario");
    if (scenario.is_object ()) {
        const std::string collection = run.collection_name.empty () ?
        string_member (scenario, "collectionId") :
        run.collection_name;
        return collection.empty () ? std::string () :
                                     "collection \"" + quote_name (collection) + "\"";
    }
    const std::string method = string_member (run.config_snapshot, "method");
    const std::string url    = string_member (run.config_snapshot, "url");
    const std::string path   = url.empty () ? std::string () : url_path (url);
    if (method.empty () || path.empty ()) {
        return method + path;
    }
    return method + " " + path;
}

/// The run's title: its request name, unless that is the default one, else
/// the collection it ran, else its target - the app's reference rule.
std::string run_title (const RunExportRun& run) {
    std::string name = string_member (run.config_snapshot, "requestName");
    const auto first = name.find_first_not_of (" \t");
    name             = first == std::string::npos ?
                std::string () :
                name.substr (first, name.find_last_not_of (" \t") - first + 1);
    if (!name.empty () && name != DEFAULT_REQUEST_NAME) {
        return name;
    }
    if (member (run.config_snapshot, "scenario").is_object ()) {
        return run.collection_name.empty () ?
        string_member (member (run.config_snapshot, "scenario"), "collectionId") :
        run.collection_name;
    }
    return run_target (run);
}

/// @p epoch_ms in UTC by @p format, or empty for an unknown start.
std::string utc_time (int64_t epoch_ms, const char* format) {
    if (epoch_ms <= 0) {
        return {};
    }
    return vayu::utils::format_utc_time (static_cast<std::time_t> (epoch_ms / 1000), format);
}

/// The `Copy for agent` run line (`docs/engine/mcp.md`, "Naming what the user
/// means"), with the start as ISO-8601 UTC: a file is read away from the
/// locale and zone that would otherwise print it.
std::string run_reference (const RunExportRun& run) {
    const std::string title = run_title (run);
    std::string details     = "load test";
    for (const std::string& part : { run_target (run),
         utc_time (run.start_time, "%Y-%m-%dT%H:%M:%SZ"), run.status }) {
        if (!part.empty ()) {
            details += ", " + part;
        }
    }
    return "Vayu run \"" + quote_name (title.empty () ? "load test" : title) +
    "\" (" + run.id + ") - " + details;
}

ordered run_section (const RunExportRun& run) {
    ordered out      = ordered::object ();
    out["id"]        = run.id;
    out["reference"] = run_reference (run);
    out["type"]      = run.type;
    out["status"]    = run.status;
    out["startTime"] = run.start_time;
    out["endTime"]   = run.end_time;
    out["name"]      = string_or_null (run.config_snapshot, "requestName");
    out["comment"]   = string_or_null (run.config_snapshot, "comment");
    out["baseline"]  = run.baseline;
    return out;
}

// --- verdict -------------------------------------------------------------------

/**
 * `{state, stoppedEarly, reason}`, the app's `judgeRun` (`run-outcome.ts`)
 * over the same report fields, so a file and the screen it came from agree:
 * a stopped run is not judged; a failed run, or a missed budget, fails; met
 * budgets pass only when no request errored; no budgets is not judged.
 */
ordered verdict_section (const json& report, std::string_view status) {
    const bool stopped = status == "stopped";
    const auto verdict = [stopped] (std::string_view state, std::string_view reason) {
        return ordered{ { "state", state }, { "stoppedEarly", stopped },
            { "reason", reason } };
    };
    if (stopped) {
        return verdict ("not_judged", "stopped");
    }
    const json& thresholds = member (report, "thresholdValidation");
    const json& checks     = member (thresholds, "checks");
    const bool budgets     = checks.is_array () && !checks.empty ();
    const bool missed = budgets && member (thresholds, "failed").is_number () &&
    member (thresholds, "failed").get<double> () > 0;
    if (status == "failed" || missed) {
        return verdict ("failed", missed ? "budgets_missed" : "run_failed");
    }
    if (!budgets) {
        return verdict ("not_judged", "no_budgets");
    }
    const json& summary   = member (report, "summary");
    const json& total     = member (summary, "totalRequests");
    const json& rate      = member (summary, "errorRate");
    const bool any_errors = total.is_number () && total.get<double> () > 0 &&
    rate.is_number () && rate.get<double> () > 0;
    return any_errors ? verdict ("not_judged", "budgets_met_with_errors") :
                        verdict ("passed", "budgets_met");
}

// --- time series -----------------------------------------------------------------

constexpr auto TICK_KEYS = std::to_array<std::string_view> ({ "elapsed_seconds",
"requests_completed", "requests_failed", "current_rps", "current_concurrency",
"throughput", "error_rate", "latency_p50_ms", "latency_p95_ms", "latency_p99_ms" });

ordered time_series (const json& ticks) {
    ordered out = ordered::array ();
    if (!ticks.is_array ()) {
        return out;
    }
    for (const json& tick : ticks) {
        ordered picked         = pick (tick, TICK_KEYS);
        picked["status_codes"] = code_counts (member (tick, "status_codes"));
        out.push_back (std::move (picked));
    }
    return out;
}

// --- comparison ------------------------------------------------------------------

/// `null` without a base; otherwise the base run's reference line and the
/// report diffed as the app diffs it (`core/run_compare.hpp`).
ordered comparison_section (const RunExportInput& input) {
    const std::optional<RunExportRun>& base = input.base;
    if (!base) {
        return nullptr;
    }
    ordered out          = ordered::object ();
    out["baseRunId"]     = base->id;
    out["baseReference"] = run_reference (*base);
    out.update (compare_run_reports (base->report, input.run.report));
    return out;
}

// --- not carried -------------------------------------------------------------------

bool has_number_above_zero (const json& value) {
    return value.is_number () && value.get<double> () > 0;
}

bool any_has_member (const json& entries, std::string_view key) {
    return entries.is_array () && std::ranges::any_of (entries, [key] (const json& entry) {
        return entry.is_object () && entry.contains (key);
    });
}

bool held_traces_or_samples (const RunExportRun& run) {
    return has_number_above_zero (member (run.report, "resultsStored")) ||
    has_number_above_zero (member (member (run.report, "sampling"), "responseBodiesCaptured"));
}

bool held_request_values (const ordered& config) {
    return !config["headerNames"].empty () || !config["paramNames"].empty () ||
    config["body"]["mode"] != "none";
}

bool held_message_text (const RunExportRun& run) {
    const json& lifecycle = member (run.report, "lifecycle");
    const json& failures = member (member (run.report, "schemaValidation"), "failures");
    return (failures.is_array () && !failures.empty ()) ||
    any_has_member (member (lifecycle, "setup"), "message") ||
    any_has_member (member (lifecycle, "teardown"), "message");
}

ordered not_carried (const RunExportRun& run, const ordered& config) {
    struct Loss {
        std::string_view code;
        std::string_view message;
        bool occurred;
    };
    const auto losses = std::to_array<Loss> ({
    { "traces_and_samples", "Per-request traces, result rows and captured response samples are left out",
    held_traces_or_samples (run) },
    { "request_values", "Header and parameter values and the request body are left out; names, the body mode and its size are kept",
    held_request_values (config) },
    { "message_text", "Messages written by scripts and schema checks are carried as counts only",
    held_message_text (run) },
    { "credential_refreshes", "When the run's OAuth 2.0 credential was renewed is left out",
    !member (run.report, "auth").is_null () },
    });
    ordered out       = ordered::array ();
    for (const Loss& loss : losses) {
        if (loss.occurred) {
            out.push_back ({ { "code", loss.code }, { "message", loss.message } });
        }
    }
    return out;
}

} // namespace

std::string render_run_export_json (const nlohmann::ordered_json& document) {
    return document.dump (2, ' ', false, ordered::error_handler_t::replace);
}

const RunExportFormat* find_run_export_format (std::string_view name) {
    const auto found =
    std::ranges::find (RUN_EXPORT_FORMATS, name, &RunExportFormat::name);
    return found == RUN_EXPORT_FORMATS.end () ? nullptr : &*found;
}

nlohmann::ordered_json
build_run_export_document (const RunExportInput& input, RunExportNotes& notes) {
    const RunExportRun& run   = input.run;
    ordered document          = ordered::object ();
    document["schema"]        = "vayu.run-report";
    document["schemaVersion"] = RUN_EXPORT_SCHEMA_VERSION;
    document["generatedAt"]   = input.generated_at;
    document["engineVersion"] = input.engine_version;
    document["run"]           = run_section (run);
    document["verdict"]       = verdict_section (run.report, run.status);
    document["config"] =
    config_section (run.config_snapshot, run.report, notes.url_credentials_omitted);
    document["report"] = report_section (run.report);
    if (input.ticks) {
        document["timeSeries"] = time_series (*input.ticks);
    }
    document["comparison"] = comparison_section (input);
    document["notCarried"] = not_carried (run, document["config"]);
    return document;
}

RunExportOutcome
export_run_report (const RunExportInput& input, const RunExportFormat& format) {
    RunExportOutcome outcome;
    const ordered document = build_run_export_document (input, outcome.notes);
    outcome.text           = format.render (document);
    outcome.mime_type      = std::string (format.mime_type);

    std::string stem      = run_title (input.run);
    const std::string utc = utc_time (input.run.start_time, "%Y-%m-%d %H%M");
    if (!utc.empty ()) {
        stem += (stem.empty () ? "" : " ") + utc;
    }
    outcome.file_name = safe_file_stem (stem, "run") + std::string (format.file_suffix);
    return outcome;
}

nlohmann::json run_export_notes_json (const RunExportNotes& notes) {
    return { { "urlCredentialsOmitted", notes.url_credentials_omitted } };
}

} // namespace vayu::core
