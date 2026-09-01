/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/runs.cpp
 * @brief Run management and reporting routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/metrics_helper.hpp"

#include <algorithm>
#include <chrono>
#include <map>
#include <thread>
#include <utility>

namespace vayu::http::routes {

namespace {

// How long DELETE /runs/:id waits for an active run's worker to settle before
// refusing the delete. Matches the 5s POST /runs/:id/stop already waits for a
// graceful stop, so a client that stops and then deletes sees one budget, not
// two different ones.
constexpr int64_t DELETE_STOP_WAIT_MS = 5000;

// Copy src[key] to dst[key] when present and not null. Shared by the list-row
// `summary` builder and the report route's `config_obj` (which adds a few
// renamed keys on top) so the two extract config fields the same way.
void add_if_present (nlohmann::json& dst, const nlohmann::json& src, const char* key) {
    if (src.contains (key) && !src[key].is_null ())
        dst[key] = src[key];
}

// httpVersion is handled separately from add_if_present, and always ends up
// present: a raw POST /runs body of `"httpVersion": null` (a request for no
// explicit protocol) lands in config_snapshot verbatim, because config_snapshot is
// built from the raw request body *before* normalize_run_http_version
// erases the key from the executed request (see execution.cpp) - and a run
// predating this field has no key at all. Neither case recorded a protocol, so
// both normalize to the literal string "auto" instead of being omitted, which
// would misrepresent "nothing was recorded" as "we lost it".
//
// Do not read that as "the run executed at auto". A load run stored before this
// branch hardcoded CURL_HTTP_VERSION_2TLS, and every run before it went out as
// HTTP/1.1 regardless because nghttp2 was not linked. "auto" here means the
// snapshot names no protocol, not that one was chosen. Never call src["httpVersion"].get<std::string>() here -
// an explicit null throws.
void add_http_version (nlohmann::json& dst, const nlohmann::json& src) {
    if (src.contains ("httpVersion") && !src["httpVersion"].is_null ()) {
        dst["httpVersion"] = src["httpVersion"];
    } else {
        dst["httpVersion"] = "auto";
    }
}

// A scenario run's list-row descriptor, or an absent key when the snapshot is
// not a scenario's.
//
// A collection run has no `url` and no `method` - its work is a sequence, not a
// request - so without this a list row carries nothing that identifies it at
// all, and the history sidebar draws a scenario run as a bare status and a
// timestamp. What a row needs is which collection ran and how big the run was.
//
// `stepCount`, not the manifest's `steps` array: the array carries a name, a
// method and a URL per step, and a list row that shipped it would undo the
// reason `summary` exists. The array stays on `GET /runs/:id`.
void add_scenario (nlohmann::json& dst, const nlohmann::json& src) {
    if (!src.contains ("scenario") || !src["scenario"].is_object ()) {
        return;
    }
    const auto& scenario = src["scenario"];

    nlohmann::json row = nlohmann::json::object ();
    for (const char* key : { "collectionId", "iterations", "recursive" }) {
        add_if_present (row, scenario, key);
    }
    if (scenario.contains ("steps") && scenario["steps"].is_array ()) {
        row["stepCount"] = scenario["steps"].size ();
    }
    if (!row.empty ()) {
        dst["scenario"] = std::move (row);
    }
}

// The compact list-row summary: exactly the nine keys the history/dashboard
// list UIs read, each omitted when absent from the snapshot (httpVersion
// excepted - see add_http_version), plus `scenario` on a collection run only.
// A malformed config_snapshot yields an empty object, never an error - the full
// snapshot stays available on GET /runs/:id.
nlohmann::json build_run_summary (const std::string& config_snapshot) {
    nlohmann::json summary = nlohmann::json::object ();
    try {
        auto config = nlohmann::json::parse (config_snapshot);
        if (config.is_object ()) {
            for (const char* key : { "url", "method", "mode", "duration",
                 "concurrency", "comment", "followRedirects", "maxRedirects" }) {
                add_if_present (summary, config, key);
            }
            add_http_version (summary, config);
            add_scenario (summary, config);
        }
    } catch (...) {
        // @deliberate: a malformed snapshot reads as an empty summary, never a
        // 500 - the run happened, and its report is not the place to relitigate
        // what was stored beside it.
    }
    return summary;
}

// Report fields that live outside the DetailedReport struct: whole-run counters
// the report injects into its `summary` object. Filled from the run's stored
// summary.
//
// `optin.performance.Padding` is right that size-ordering these fields would
// save 44 bytes, and the trade is refused deliberately: the layout is by report
// section - each `has_*` flag sits with the block it gates and the paragraph
// explaining why absent is not zero - and size order interleaves all six
// sections, leaving every comment describing fields that no longer follow it.
// One of these exists per `GET /runs/:id/report` call, on the stack, so the
// 44 bytes buy nothing measurable; the grouping is read by everyone who touches
// the report. Revisit if this is ever held per run or per result.
// NOLINTNEXTLINE(clang-analyzer-optin.performance.Padding)
struct ReportExtras {
    double peak_concurrency = 0.0;
    double dropped_total    = 0.0;
    double queue_wait_avg   = 0.0;
    double bytes_sent       = 0.0;
    double bytes_received   = 0.0;
    // True once an authoritative status-code distribution replaced the one
    // derived from the sampled results - only then are successful/failed
    // recounted from it (a run with neither keeps the sampled figures).
    bool status_codes_overridden = false;
    // Script-validation tallies; `has_tests` false leaves the report's
    // testValidation section out entirely.
    bool has_tests    = false;
    int tests_sampled = 0;
    int tests_passed  = 0;
    int tests_failed  = 0;
    // The run's verdict against its declared budgets. `has_thresholds` false is
    // a run that declared none (or one recorded before budgets existed), which
    // leaves thresholdValidation out entirely - a run that declared nothing did
    // not pass zero checks, it was never judged.
    bool has_thresholds      = false;
    size_t thresholds_passed = 0;
    size_t thresholds_failed = 0;
    // Per-budget rows verbatim from the summary, already in the report's
    // camelCase shape - the evaluator writes the wire keys.
    nlohmann::json threshold_checks = nlohmann::json::array ();
    // Whether the run's OAuth 2.0 credential was refreshed while it ran.
    // `has_auth` false is a run that could not refresh at all (no oauth2 auth,
    // a non-expiring or query-placed token, or an engine older than mid-run
    // refresh), which is not the same as a run that watched and never needed to
    // - so the section is left out rather than reported as zero refreshes.
    bool has_auth                 = false;
    nlohmann::json auth_refreshes = nlohmann::json::array ();
    size_t auth_refresh_failures  = 0;
    std::string auth_last_error;
    // What a capacity run's search found, already translated into the report's
    // camelCase shape. `has_capacity` false is every other mode - a run with a
    // fixed target measured a point, not a curve, and reporting a knee of zero
    // would name a limit nothing observed.
    bool has_capacity       = false;
    nlohmann::json capacity = nlohmann::json::object ();
    // What a streaming run's completions delivered, passed through verbatim -
    // the producer already writes the report's camelCase names, so re-keying
    // here would be a second place to keep them (issue #576). Empty is every
    // non-streaming run, which leaves the section out rather than reporting an
    // ordinary load run an event rate of zero.
    nlohmann::json stream = nlohmann::json::object ();
    // What the run's bounded stores thinned away. `has_sampling` false is a
    // run recorded before retention was reported, which is not the same as a
    // run that dropped nothing - so the section is left out rather than shown
    // as all zeros.
    bool has_sampling               = false;
    size_t errors_dropped           = 0;
    size_t success_traces_dropped   = 0;
    size_t slow_traces_dropped      = 0;
    size_t response_samples_dropped = 0;
    size_t exemplars_dropped        = 0;
    size_t sample_bodies_dropped    = 0;
    // A scenario run's own tallies, read from the summary's `scenario` object.
    // `has_scenario` false leaves the section out entirely rather than showing
    // a load run four zeros - the section exists to say what a sequence did.
    bool has_scenario           = false;
    size_t iterations           = 0;
    size_t iterations_completed = 0;
    size_t steps_executed       = 0;
    size_t steps_passed         = 0;
    size_t steps_failed         = 0;
    size_t steps_skipped        = 0;
    size_t steps_errored        = 0;
    size_t steps_stored         = 0;
    // Step results the run's bounded store thinned away. Failures are kept
    // first, so a non-zero count here means successes are missing from
    // `results[]`, never a failure.
    size_t steps_dropped = 0;
    // Load-mode scenario runs only. `virtual_users` is what `concurrency` meant
    // for this run; `iterations_abandoned` is how many an errored step ended
    // before the plan's last step, which is what explains a breakdown that
    // thins towards the end of the sequence.
    size_t virtual_users        = 0;
    size_t iterations_abandoned = 0;
    // Per-step latency and counts, verbatim from the summary. Empty for a
    // design-mode run, which reports its steps as `results[]` rows instead.
    nlohmann::json step_breakdown = nlohmann::json::array ();
    // Non-zero means this run stored response headers and bodies verbatim.
    // Capture does not redact, by decision, so the Samples tab reads this to
    // warn rather than leaving the reader to infer it.
    size_t response_bodies_captured = 0;
    // What the run's server-vitals scrape recorded, verbatim from the summary
    // (per-series min/max/avg plus the sample and gap counts). `has_monitor`
    // false leaves the section out entirely - a run that configured no monitor
    // did not measure a target reporting zeros.
    bool has_monitor       = false;
    nlohmann::json monitor = nlohmann::json::object ();
    // How many of this run's transfers asked for HTTP/2 and negotiated
    // something older. Not a performance number - it is what tells the reader
    // whether the protocol the report is labelled with is the one the numbers
    // were measured over (issue #215).
    double http_version_downgraded = 0.0;
    // Per-phase latency distributions, verbatim from the summary and already in
    // the report's shape. Empty for a run that recorded none - the toggle off,
    // nothing successful completed, or an engine older than the phase bank -
    // which leaves `timingBreakdown.phases` out. The averages beside it are
    // computed over the retained sample and stay whatever they were; these are
    // the whole population, so a reader comparing the two is comparing a
    // sample's mean against every completion's distribution, not two views of
    // the same rows.
    nlohmann::json phases = nlohmann::json::object ();
    // Which of the bound contract's operations the run exercised (issue #629),
    // passed through verbatim: the producer writes the report's own camelCase,
    // the `stream`/`monitor` rule. Empty is every run not measured against a
    // contract - an unbound collection, a single-request run, or a document
    // stored before the operation index existed - and leaves the section out,
    // because a run that was never judged against a contract did not fail one.
    nlohmann::json coverage = nlohmann::json::object ();
    // What checking the run's *sampled* responses against that same contract
    // found (issue #682), passed through verbatim on the `coverage` terms.
    // Empty is every run that validated nothing - an unbound collection, a
    // single-request run, a document carrying no response schemas - and leaves
    // the section out, because a run whose responses were never checked did not
    // pass a contract. Sampled where `coverage` is exact; the block says so.
    nlohmann::json schema_validation = nlohmann::json::object ();
};

// Read a number out of a JSON object, leaving @p out untouched when the key is
// absent or not a number - so a summary written by an older engine (or a
// partial one from a crashed run) falls back to the calculated value instead of
// zeroing it.
template <typename T>
void read_number (const nlohmann::json& obj, const char* key, T& out) {
    if (obj.contains (key) && obj[key].is_number ()) {
        out = obj[key].get<T> ();
    }
}

// Translate a stored `capacity` section (snake_case, like every stored section)
// into the report's camelCase shape.
//
// Every field is optional on the way in: `max_healthy_*` is absent when the
// very first level already breached the SLO, `knee_*` when the search ended for
// a reason other than latency, and a summary written by an older engine has
// none of them. Only a section that carries at least the levels it measured is
// reported at all - an empty one says nothing a reader can act on, the same
// rule the thresholds section follows.
void read_capacity_section (const nlohmann::json& stored, ReportExtras& extras) {
    if (!stored.contains ("levels") || !stored["levels"].is_array ()) {
        return;
    }

    nlohmann::json levels = nlohmann::json::array ();
    for (const auto& level : stored["levels"]) {
        if (!level.is_object ()) {
            continue;
        }
        size_t concurrency = 0;
        double rps         = 0.0;
        double p99_ms      = 0.0;
        read_number (level, "concurrency", concurrency);
        read_number (level, "rps", rps);
        read_number (level, "p99_ms", p99_ms);
        levels.push_back (
        { { "concurrency", concurrency }, { "rps", rps }, { "p99Ms", p99_ms } });
    }

    nlohmann::json capacity;
    double slo_ms = 0.0;
    read_number (stored, "slo_ms", slo_ms);
    capacity["sloMs"] = slo_ms;
    capacity["stopReason"] =
    stored.contains ("stop_reason") && stored["stop_reason"].is_string () ?
    stored["stop_reason"].get<std::string> () :
    std::string{};
    capacity["levels"] = levels;

    if (stored.contains ("max_healthy_concurrency")) {
        size_t concurrency = 0;
        double rps         = 0.0;
        double p99_ms      = 0.0;
        read_number (stored, "max_healthy_concurrency", concurrency);
        read_number (stored, "max_healthy_rps", rps);
        read_number (stored, "p99_at_max_healthy_ms", p99_ms);
        capacity["maxHealthyConcurrency"] = concurrency;
        capacity["maxHealthyRps"]         = rps;
        capacity["p99AtMaxHealthyMs"]     = p99_ms;
    }
    if (stored.contains ("knee_concurrency")) {
        size_t concurrency = 0;
        double p99_ms      = 0.0;
        read_number (stored, "knee_concurrency", concurrency);
        read_number (stored, "knee_p99_ms", p99_ms);
        capacity["kneeConcurrency"] = concurrency;
        capacity["kneeP99Ms"]       = p99_ms;
    }

    extras.has_capacity = true;
    extras.capacity     = std::move (capacity);
}

/** The whole-run totals and the latency distribution. */
void apply_summary_totals (const nlohmann::json& summary,
vayu::DetailedReport& report,
ReportExtras& extras) {
    read_number (summary, "total_requests", report.total_requests);
    read_number (summary, "send_rate", report.send_rate);
    read_number (summary, "throughput", report.throughput);
    read_number (summary, "test_duration", report.total_duration_s);
    read_number (summary, "setup_overhead", report.setup_overhead_s);
    if (summary.contains ("rps") && summary["rps"].is_number ()) {
        report.avg_rps    = summary["rps"].get<double> ();
        report.actual_rps = report.avg_rps;
    }

    read_number (summary, "peak_concurrency", extras.peak_concurrency);
    read_number (summary, "dropped_requests", extras.dropped_total);
    read_number (summary, "queue_wait_avg", extras.queue_wait_avg);
    read_number (summary, "bytes_sent", extras.bytes_sent);
    read_number (summary, "bytes_received", extras.bytes_received);
    read_number (summary, "http_version_downgraded", extras.http_version_downgraded);

    if (summary.contains ("latency") && summary["latency"].is_object ()) {
        const auto& latency = summary["latency"];
        read_number (latency, "min", report.latency_min);
        read_number (latency, "max", report.latency_max);
        read_number (latency, "avg", report.latency_avg);
        read_number (latency, "p50", report.latency_p50);
        read_number (latency, "p75", report.latency_p75);
        read_number (latency, "p90", report.latency_p90);
        read_number (latency, "p95", report.latency_p95);
        read_number (latency, "p99", report.latency_p99);
        read_number (latency, "p999", report.latency_p999);
    }
}

/** The status-code map, which replaces the sampled one wholesale when stored. */
void apply_summary_status_codes (const nlohmann::json& summary,
vayu::DetailedReport& report,
ReportExtras& extras) {
    if (summary.contains ("status_codes") &&
    summary["status_codes"].is_object () && !summary["status_codes"].empty ()) {
        report.status_codes.clear ();
        extras.status_codes_overridden = true;
        for (const auto& [code_str, count] : summary["status_codes"].items ()) {
            try {
                report.status_codes[std::stoi (code_str)] = count.get<size_t> ();
            } catch (...) {
                // @deliberate: skip an unparseable code rather than losing the
                // whole map - every other key is still an honest count.
            }
        }
    }
}

/** What sampling dropped, so the report can say what it is a sample of. */
void apply_summary_sampling (const nlohmann::json& summary, ReportExtras& extras) {
    if (summary.contains ("sampling") && summary["sampling"].is_object ()) {
        extras.has_sampling  = true;
        const auto& sampling = summary["sampling"];
        read_number (sampling, "errors_dropped", extras.errors_dropped);
        read_number (sampling, "success_traces_dropped", extras.success_traces_dropped);
        read_number (sampling, "slow_traces_dropped", extras.slow_traces_dropped);
        read_number (sampling, "response_samples_dropped", extras.response_samples_dropped);
        read_number (sampling, "exemplars_dropped", extras.exemplars_dropped);
        read_number (sampling, "sample_bodies_dropped", extras.sample_bodies_dropped);
        read_number (sampling, "response_bodies_captured", extras.response_bodies_captured);
    }
}

/** The scenario breakdown - for a load-mode scenario, the only per-step record there is. */
void apply_summary_scenario (const nlohmann::json& summary, ReportExtras& extras) {
    if (summary.contains ("scenario") && summary["scenario"].is_object ()) {
        extras.has_scenario  = true;
        const auto& scenario = summary["scenario"];
        read_number (scenario, "iterations", extras.iterations);
        read_number (scenario, "iterations_completed", extras.iterations_completed);
        read_number (scenario, "steps_executed", extras.steps_executed);
        read_number (scenario, "passed", extras.steps_passed);
        read_number (scenario, "failed", extras.steps_failed);
        read_number (scenario, "skipped", extras.steps_skipped);
        read_number (scenario, "errored", extras.steps_errored);
        read_number (scenario, "steps_stored", extras.steps_stored);
        read_number (scenario, "steps_dropped", extras.steps_dropped);
        // Load-mode only: the design-mode runner writes neither, and a load run
        // stores no per-step `results` rows at all - the breakdown *is* how a
        // scenario load run says what each step did.
        read_number (scenario, "virtual_users", extras.virtual_users);
        read_number (scenario, "iterations_abandoned", extras.iterations_abandoned);
        if (scenario.contains ("steps") && scenario["steps"].is_array ()) {
            extras.step_breakdown = scenario["steps"];
        }
    }
}

/** What the run observed beside its own timings: vitals, tests, auth, capacity. */
void apply_summary_observations (const nlohmann::json& summary, ReportExtras& extras) {
    if (summary.contains ("monitor") && summary["monitor"].is_object ()) {
        extras.has_monitor = true;
        extras.monitor     = summary["monitor"];
    }

    if (summary.contains ("tests") && summary["tests"].is_object ()) {
        extras.has_tests = true;
        read_number (summary["tests"], "sampled", extras.tests_sampled);
        read_number (summary["tests"], "passed", extras.tests_passed);
        read_number (summary["tests"], "failed", extras.tests_failed);
    }

    if (summary.contains ("auth") && summary["auth"].is_object ()) {
        const auto& auth = summary["auth"];
        extras.has_auth  = true;
        if (auth.contains ("refreshes") && auth["refreshes"].is_array ()) {
            extras.auth_refreshes = auth["refreshes"];
        }
        read_number (auth, "refreshFailures", extras.auth_refresh_failures);
        if (auth.contains ("lastError") && auth["lastError"].is_string ()) {
            extras.auth_last_error = auth["lastError"].get<std::string> ();
        }
    }

    if (summary.contains ("capacity") && summary["capacity"].is_object ()) {
        read_capacity_section (summary["capacity"], extras);
    }
}

/**
 * The sections stored in the report's own wire shape and passed through rather
 * than re-keyed: the producer writes the report's names, so a translation table
 * here would be a second place to keep them. An empty section is treated as
 * absent - it names nothing a reader can act on.
 */
void apply_summary_sections (const nlohmann::json& summary, ReportExtras& extras) {
    // Per-phase distributions, passed through rather than re-keyed: the
    // producer writes the report's own wire names (TIMING_PHASE_KEYS), so a
    // translation table here would be a second place to keep them. An empty
    // object is treated as absent - it names no phase a reader can act on.
    if (summary.contains ("phases") && summary["phases"].is_object () &&
    !summary["phases"].empty ()) {
        extras.phases = summary["phases"];
    }

    // Same pass-through, same empty-is-absent rule (issue #576).
    if (summary.contains ("stream") && summary["stream"].is_object () &&
    !summary["stream"].empty ()) {
        extras.stream = summary["stream"];
    }

    // Same again for contract coverage (issue #629). An object with no
    // `operations` array says nothing a reader can act on and is treated as
    // absent, the rule `thresholds` follows for its `checks`.
    if (summary.contains ("coverage") && summary["coverage"].is_object () &&
    summary["coverage"].contains ("operations") &&
    summary["coverage"]["operations"].is_array () &&
    !summary["coverage"]["operations"].empty ()) {
        extras.coverage = summary["coverage"];
    }

    // Same again for sampled schema validation (issue #682). A block with no
    // `sampled` count says nothing a reader can act on - and cannot be labelled
    // honestly as a sample - so it is treated as absent.
    if (summary.contains ("schemaValidation") && summary["schemaValidation"].is_object () &&
    summary["schemaValidation"].contains ("sampled") &&
    summary["schemaValidation"]["sampled"].is_number () &&
    summary["schemaValidation"]["sampled"].get<size_t> () > 0) {
        extras.schema_validation = summary["schemaValidation"];
    }

    if (summary.contains ("thresholds") && summary["thresholds"].is_object ()) {
        const auto& thresholds = summary["thresholds"];
        // The checks are the section: a stored object with no readable rows
        // says nothing a reader can act on, so it is treated as absent rather
        // than reported as a run that passed and failed nothing.
        if (thresholds.contains ("checks") &&
        thresholds["checks"].is_array () && !thresholds["checks"].empty ()) {
            extras.has_thresholds   = true;
            extras.threshold_checks = thresholds["checks"];
            read_number (thresholds, "passed", extras.thresholds_passed);
            read_number (thresholds, "failed", extras.thresholds_failed);
        }
    }
}

/**
 * Apply the run's stored `summary` (the whole-run results, written once at
 * terminal status) over the report calculated from the sampled `results`.
 *
 * An absent or unreadable summary leaves the report exactly as the sampled
 * results computed it - there is no second source to fall back to. Keys here
 * are the ones `vayu::core::build_run_summary_payload` writes;
 * runs_route_test.cpp round-trips the pair so the two sides cannot drift apart
 * silently.
 */
void apply_run_summary (const std::string& summary_json,
vayu::DetailedReport& report,
ReportExtras& extras) {
    if (summary_json.empty ()) {
        return;
    }
    nlohmann::json summary;
    try {
        summary = nlohmann::json::parse (summary_json);
    } catch (...) {
        vayu::utils::log_warning ("Run summary is not valid JSON; reporting "
                                  "from the sampled results alone");
        return;
    }
    if (!summary.is_object ()) {
        vayu::utils::log_warning ("Run summary is not an object; reporting "
                                  "from the sampled results alone");
        return;
    }

    apply_summary_totals (summary, report, extras);
    apply_summary_status_codes (summary, report, extras);
    apply_summary_sampling (summary, extras);
    apply_summary_scenario (summary, extras);
    apply_summary_observations (summary, extras);
    apply_summary_sections (summary, extras);
}

// Serialize one run into a list row: identity + status + the compact summary,
// deliberately *without* the full config_snapshot (that is what makes the list
// cheap). Mirrors the camelCase keys vayu::json::serialize(Run) emits.
//
// The summary is passed in rather than built here, so each caller decides where
// it comes from: the polled list takes it from the run-summary cache, and the
// one-row baseline response - which no client polls - builds it directly.
nlohmann::json serialize_run_row (const vayu::db::Run& run, nlohmann::json summary) {
    nlohmann::json row;
    row["id"]        = run.id;
    row["type"]      = vayu::to_string (run.type);
    row["status"]    = vayu::to_string (run.status);
    row["startTime"] = run.start_time;
    row["endTime"]   = run.end_time;
    row["requestId"] = run.request_id.has_value () ? nlohmann::json (*run.request_id) :
                                                     nlohmann::json (nullptr);
    row["environmentId"] = run.environment_id.has_value () ?
    nlohmann::json (*run.environment_id) :
    nlohmann::json (nullptr);
    row["baseline"]      = run.baseline;
    row["summary"]       = std::move (summary);
    return row;
}

} // namespace

/**
 * Testable core of the paginated GET /runs list, returning {http_status,
 * json_body}. Always 200 - a list of zero rows is a valid list, not a 404.
 *
 * `limit`/`offset` arrive already parsed and clamped by the caller (limit
 * default 50, capped at 500; offset floored at 0); `filter` holds the already
 * validated type/status/requestId/q constraints. Rows carry the compact
 * `summary` (nine keys) instead of the full `config_snapshot`, wrapped in the
 * same `{data, pagination}` envelope GET /runs/:id/metrics uses (post-#86); a
 * design run's row also carries `resultSummary` (statusCode + latencyMs), which
 * is what a reader would otherwise fetch a report per row to learn.
 *
 * `summaries` spares the poll the work it would otherwise repeat: this is the
 * endpoint a visible history surface re-asks every 5s, and each call used to
 * re-parse every row's immutable `config_snapshot` to rebuild the summary the
 * previous call had already built (#1150). It is a parameter rather than a
 * detail of this function so a caller - a test included - owns the cache's
 * lifetime and two of them never share one.
 *
 * Extracted so the envelope shape, clamping and filtering are covered without
 * an in-process HTTP server - see runs_route_test.cpp. Exceptions propagate to
 * the route's try/catch (500).
 */
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter,
int64_t limit,
int64_t offset,
vayu::http::RunSummaryCache& summaries) {
    const int64_t total = db.count_runs (filter);
    auto runs           = db.get_runs_paginated (filter, limit, offset);

    // A design run is one exchange, so its outcome fits on its row and the page
    // pays one extra query for all of them (get_design_result_outcomes). A load
    // or scenario run's results are many and unbounded, so its row carries none
    // - the same split GET /runs/:id draws with attach_design_result, and the
    // reason `resultSummary` is the two numbers rather than the exchange.
    std::vector<std::string> design_run_ids;
    for (const auto& run : runs) {
        if (run.type == vayu::RunType::Design) {
            design_run_ids.push_back (run.id);
        }
    }
    const auto outcomes = db.get_design_result_outcomes (design_run_ids);

    nlohmann::json data = nlohmann::json::array ();
    for (const auto& run : runs) {
        auto row = serialize_run_row (run, summaries.summary_for (run.id, [&run] {
            return build_run_summary (run.config_snapshot);
        }));
        if (const auto found = outcomes.find (run.id); found != outcomes.end ()) {
            row["resultSummary"]["statusCode"] = found->second.status_code;
            row["resultSummary"]["latencyMs"]  = found->second.latency_ms;
        }
        data.push_back (std::move (row));
    }

    nlohmann::json response;
    response["data"]                 = std::move (data);
    response["pagination"]["total"]  = total;
    response["pagination"]["limit"]  = limit;
    response["pagination"]["offset"] = offset;
    response["pagination"]["hasMore"] =
    (offset + static_cast<int64_t> (runs.size ())) < total;
    response["pagination"]["returned"] = runs.size ();
    return { 200, response };
}

/**
 * Testable core of GET /runs/:id/samples, returning {http_status, json_body}.
 * A missing run is a 404 in the shared error shape; a run that captured
 * nothing is an empty page, not an error.
 *
 * Deliberately **not** an extension of the report's `results[]` array. That
 * path loads every result row for a run and JSON-parses each `trace_data` to
 * accumulate aggregates that never look at a body, and the dashboard polls it;
 * bodies travelling on it would turn a ~200-byte-per-row read into a megabytes
 * one on every poll. So the exchanges live in their own tables and are fetched
 * here, per page, only when a reader actually expands a sample.
 *
 * `limit`/`offset` arrive already parsed and clamped by the caller. The
 * envelope is the `{data, pagination}` shape GET /runs and GET /runs/:id/metrics
 * already use.
 */
std::pair<int, nlohmann::json> run_samples_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    const int64_t total = db.count_result_bodies (run_id);
    auto rows = db.get_result_bodies_paginated (run_id, limit, offset);

    // Read once for the page, not once per streamed row: the caps are what the
    // reader's own settings say now, and a page whose rows were bounded by two
    // different rules would be a page nobody could describe.
    const vayu::http::SseLimits sse_limits = vayu::http::read_sse_limits (db);

    // Bodies are deduplicated in storage, so a page of 50 samples of the same
    // response points at one blob. Read it once rather than 50 times.
    std::map<int, std::string> blob_cache;

    nlohmann::json data = nlohmann::json::array ();
    for (const auto& row : rows) {
        nlohmann::json sample;
        // The `results.id` this exchange belongs to. Clients join it against
        // the report's `results[].id` rather than re-deriving an order.
        sample["resultId"] = row.result_id;

        nlohmann::json response = nlohmann::json::object ();
        try {
            response["headers"] = nlohmann::json::parse (row.headers);
        } catch (...) {
            response["headers"] = nlohmann::json::object ();
        }
        response["bodyBytes"] = row.body_bytes;
        if (!row.content_type.empty ()) {
            response["contentType"] = row.content_type;
        }

        if (row.is_binary) {
            // A binary body is reported as its shape, never as text: the
            // alternative is a mojibake that reads like a real response.
            response["binary"] = true;
        } else {
            auto cached = blob_cache.find (row.blob_id);
            if (cached == blob_cache.end ()) {
                cached = blob_cache
                         .emplace (row.blob_id, db.get_body_blob_content (row.blob_id))
                         .first;
            }
            response["body"] = cached->second;
            if (row.truncated) {
                // Same convention design-mode traces use (cap_trace_bodies), so
                // a reader has one rule for "this is a slice".
                response["bodyTruncated"] = true;
            }
            // A streamed sample's events, parsed back from the body it stored
            // (issue #657). Absent unless the row recorded a wire event count,
            // so a non-stream sample - and every row written before the column
            // existed - carries no `events` node at all rather than an empty
            // one. Derived here rather than stored a second time: the body is
            // the event list, and two copies of one fact drift.
            if (row.stream_events) {
                response["events"] = vayu::http::buffered_stream_events_node (
                cached->second, sse_limits, *row.stream_events, !row.truncated);
            }
            // No blob and not binary means the run's capture budget was spent
            // before this sample: headers were kept, the body was not. Said
            // explicitly so the UI does not render "empty response body".
            if (row.blob_id == 0 && row.body_bytes > 0) {
                response["bodyDropped"] = true;
            }
        }

        sample["response"] = std::move (response);
        data.push_back (std::move (sample));
    }

    nlohmann::json body;
    body["data"]                 = std::move (data);
    body["pagination"]["total"]  = total;
    body["pagination"]["limit"]  = limit;
    body["pagination"]["offset"] = offset;
    body["pagination"]["hasMore"] = (offset + static_cast<int64_t> (rows.size ())) < total;
    body["pagination"]["returned"] = rows.size ();
    return { 200, body };
}

/**
 * The GET /runs/:runId/report `configuration` object: the load-test tuning
 * knobs plus httpVersion/followRedirects/maxRedirects (ten keys total), built
 * from an already-parsed config_snapshot. `rps`/`targetRps` is the one
 * rename, so it stays as an inline branch in the caller rather than living in
 * this key list.
 *
 * Extracted (like get_runs_response above) so this is covered directly - see
 * runs_route_test.cpp - without the full report handler's DB/metrics reads.
 */
nlohmann::json build_run_report_config (const nlohmann::json& config) {
    nlohmann::json config_obj = nlohmann::json::object ();
    for (const char* key : { "mode", "duration", "concurrency", "startConcurrency",
         "rampUpDuration", "timeout", "comment", "followRedirects", "maxRedirects",
         // The size of the data set a run bound (issue #993). The snapshot
         // carries the count in the rows' place - they are never persisted -
         // and this is what carries it to the reader: the dashboard's run
         // metadata prints it, so "this run was data-driven, over N rows" is
         // recoverable from the report rather than only from the payload the
         // caller no longer has.
         "dataRowCount" }) {
        add_if_present (config_obj, config, key);
    }
    add_http_version (config_obj, config);
    return config_obj;
}

/**
 * Testable core of PUT /runs/:id/baseline, returning {http_status, json_body}.
 *
 * PUT rather than POST because this updates an existing run (the repo's
 * create-vs-update rule, issue #95), and a whole endpoint rather than a field
 * on a general run update because a run has no general update: everything else
 * on the row is written by the engine as the run executes.
 *
 * `baseline` is required and must be a real boolean. The merge-patch helper
 * `apply_bool_field` ignores a non-boolean instead, which is right for an
 * optional field among many and wrong here - this body has exactly one field,
 * so ignoring it would answer 200 to a request that changed nothing.
 *
 * 200 carries the updated row in the same shape `GET /runs` lists, so a client
 * can patch its cached row from the response instead of re-listing.
 */
std::pair<int, nlohmann::json> set_run_baseline_response (vayu::db::Database& db,
const std::string& run_id,
const std::string& body) {
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (body);
    } catch (const std::exception&) {
        return { 400, error_body (400, "Invalid JSON body") };
    }
    if (!parsed.is_object () || !parsed.contains ("baseline")) {
        return { 400, error_body (400, "Missing 'baseline': expected {\"baseline\": true|false}") };
    }
    if (!parsed["baseline"].is_boolean ()) {
        return { 400, error_body (400, "Invalid 'baseline': must be a boolean") };
    }

    auto updated = db.set_run_baseline (run_id, parsed["baseline"].get<bool> ());
    if (!updated) {
        return { 404, error_body (404, "Run not found") };
    }
    return { 200, serialize_run_row (*updated, build_run_summary (updated->config_snapshot)) };
}

/**
 * Testable core of DELETE /runs/:id, returning {http_status, json_body}.
 *
 * Deleting a run that is still executing used to remove its rows while its
 * detached worker kept writing new metrics and results against the same id -
 * permanently orphaned rows, and a run that partially "un-deleted" itself as it
 * finished. So an active run is stopped first: the stop is signalled the same
 * way POST /runs/:id/stop signals it, and the delete waits for the worker to
 * hand the run over to the retained map, which it only does after its last
 * database write.
 *
 * If the worker has not settled within `stop_wait_ms` the run is *not* deleted
 * and the caller gets a 409 - a partial delete racing a live writer is the one
 * outcome worth refusing outright. The stop still stands, so a retry a moment
 * later succeeds.
 *
 * A run whose stored status is `running` but which has no context (the daemon
 * restarted under it) has no writer to race and is deleted directly.
 */
std::pair<int, nlohmann::json> delete_run_response (vayu::db::Database& db,
vayu::core::RunManager& run_manager,
const std::string& run_id,
int64_t stop_wait_ms) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    if (auto context = run_manager.get_run (run_id)) {
        vayu::utils::log_info (
        "DELETE /runs/:id - Run is active, stopping it first: " + run_id);
        context->should_stop = true;
        // Wake the closed-loop controller so it observes should_stop without
        // waiting out its 50ms safety-net timeout.
        context->notify_refill ();

        // retain_run() is the worker's last act, after the final metrics flush
        // and status update, so "no longer active" is the only signal that says
        // every writer is done with this id.
        const auto deadline = std::chrono::steady_clock::now () +
        std::chrono::milliseconds (stop_wait_ms);
        while (run_manager.get_run (run_id) != nullptr) {
            if (std::chrono::steady_clock::now () >= deadline) {
                vayu::utils::log_warning (
                "DELETE /runs/:id - Run did not settle within " +
                std::to_string (stop_wait_ms) + "ms, refusing to delete: " + run_id);
                return { 409,
                    error_body (409,
                    "Run is still stopping; it was not deleted. Retry once it "
                    "reports a terminal status.") };
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (20));
        }
    }

    db.delete_run (run_id);
    return { 200,
        nlohmann::json{ { "message", "Run deleted successfully" }, { "runId", run_id } } };
}

/**
 * The figures the stored summary and the sampled results have to be reconciled
 * into: the success/failure split from whichever status distribution won, the
 * error rate that split implies, and the run's rate against its declared target.
 *
 * @return the target RPS the run declared, 0 when it declared none.
 */
double reconcile_report_rates (const std::string& config_snapshot,
double duration_s,
const ReportExtras& extras,
vayu::DetailedReport& report) {
    // Recount the success/failure split from whichever distribution won, so
    // transport errors (status code 0) are counted. Runs with no stored
    // distribution keep the figures derived from the sampled results.
    if (extras.status_codes_overridden) {
        report.successful_requests = 0;
        report.failed_requests     = 0;
        report.errors_by_status_code.clear ();
        for (const auto& [code, count] : report.status_codes) {
            if (vayu::is_success_status (code)) {
                report.successful_requests += count;
            } else {
                report.failed_requests += count;
            }
            if (code == 0 || code >= 400) {
                report.errors_by_status_code[code] = count;
            }
        }
    }

    // Recompute the error rate from the reconciled successful/failed split -
    // the sampled-results error_rate from calculate_detailed_report omits
    // transport errors.
    report.error_rate = report.total_requests > 0 ?
    static_cast<double> (report.failed_requests) * 100.0 /
    static_cast<double> (report.total_requests) :
    0.0;

    // Extract target RPS from config
    double target_rps = 0.0;
    try {
        auto config = nlohmann::json::parse (config_snapshot);
        if (config.contains ("rps")) {
            target_rps = config["rps"].get<double> ();
        } else if (config.contains ("targetRps")) {
            target_rps = config["targetRps"].get<double> ();
        }
    } catch (...) {
        // @deliberate: a snapshot that will not read leaves the target at 0,
        // which `rps_achievement` below already spells as "no target was
        // declared" - the same answer a run that declared none gives.
    }

    report.target_rps = target_rps;
    if (report.actual_rps == 0) {
        report.actual_rps = report.avg_rps;
    }
    report.rps_achievement =
    target_rps > 0 ? (report.actual_rps / target_rps * 100.0) : 0.0;

    // Fallback: calculate duration from RPS when no stored test duration
    // replaced the wall-clock one (older runs).
    if (report.total_duration_s == duration_s && report.actual_rps > 0 &&
    report.total_requests > 0) {
        report.total_duration_s =
        static_cast<double> (report.total_requests) / report.actual_rps;
    }
    return target_rps;
}

/** What the report says the run *was* - identity, status, and what was asked for. */
nlohmann::json build_report_metadata (const std::string& run_id, const vayu::db::Run& run) {
    // Build response
    nlohmann::json metadata;
    metadata["runId"]     = run_id;
    metadata["runType"]   = vayu::to_string (run.type);
    metadata["status"]    = vayu::to_string (run.status);
    metadata["startTime"] = run.start_time;
    metadata["endTime"]   = run.end_time;

    try {
        auto config = nlohmann::json::parse (run.config_snapshot);
        // HTTP request fields are at root level (unified structure)
        if (config.contains ("url")) {
            metadata["requestUrl"] = config["url"];
        }
        if (config.contains ("method")) {
            metadata["requestMethod"] = config["method"];
        }

        // Eleven keys, built by build_run_report_config above - the seven
        // load-test tuning knobs, httpVersion/followRedirects/maxRedirects, and
        // the bound row count. `rps` is the one rename (-> targetRps) and stays
        // inline here rather than in that key list.
        nlohmann::json config_obj = build_run_report_config (config);
        if (config.contains ("rps"))
            config_obj["targetRps"] = config["rps"];
        if (config.contains ("targetRps"))
            config_obj["targetRps"] = config["targetRps"];

        if (!config_obj.empty ()) {
            metadata["configuration"] = config_obj;
        }

        // The spec this run was planned against (issue #637), echoed from the
        // snapshot the scenario manifest stamped it into. Echoed rather than
        // re-read from the collection: the binding is free to have moved since,
        // and a report has to say what the run was measured against, not what
        // the collection points at today. Absent for an unbound run, which is
        // how the manifest stores it - #629's coverage block reads this.
        if (auto scenario = config.find ("scenario");
        scenario != config.end () && scenario->is_object ()) {
            if (auto openapi = scenario->find ("openapi");
            openapi != scenario->end () && openapi->is_object ()) {
                metadata["openapi"] = *openapi;
            }
        }
    } catch (...) {
        // @deliberate: metadata is describing a run that already happened, so
        // an unreadable snapshot costs the `configuration` block and nothing
        // else - the measured half of the report is built above this.
    }
    return metadata;
}

/**
 * The sections a run only has if it did the thing they describe: a sequence, a
 * monitored target, tests, a capacity search, a bound contract, thresholds, a
 * credential that was renewed under it.
 */
void add_optional_report_sections (const ReportExtras& extras, nlohmann::json& json_report) {
    // What the sequence did, step by step. `stepsStored` vs `stepsExecuted` is
    // the honest reading of `results[]` below: a run whose store filled reports
    // fewer rows than steps, with every non-passing step among them.
    if (extras.has_scenario) {
        json_report["scenario"] = { { "iterations", extras.iterations },
            { "iterationsCompleted", extras.iterations_completed },
            { "stepsExecuted", extras.steps_executed }, { "passed", extras.steps_passed },
            { "failed", extras.steps_failed }, { "skipped", extras.steps_skipped },
            { "errored", extras.steps_errored }, { "stepsStored", extras.steps_stored },
            { "stepsDropped", extras.steps_dropped } };
        // Added only when the run actually has them, so a design-mode run's
        // section keeps the exact shape the app already renders.
        if (extras.virtual_users > 0) {
            json_report["scenario"]["virtualUsers"] = extras.virtual_users;
            json_report["scenario"]["iterationsAbandoned"] = extras.iterations_abandoned;
        }
        if (!extras.step_breakdown.empty ()) {
            json_report["scenario"]["steps"] = extras.step_breakdown;
        }
    }

    // Server vitals beside the run's own numbers. Passed through as stored:
    // the totals are written in the report's own shape, so there is one
    // description of the section rather than a writer and a translator.
    if (extras.has_monitor) {
        json_report["monitor"] = extras.monitor;
    }

    if (extras.has_tests) {
        json_report["testValidation"] = { { "samplesTested", extras.tests_sampled },
            { "testsPassed", extras.tests_passed }, { "testsFailed", extras.tests_failed },
            { "successRate",
            extras.tests_sampled > 0 ?
            (static_cast<double> (extras.tests_passed) * 100.0 /
            static_cast<double> (extras.tests_passed + extras.tests_failed)) :
            0.0 } };
    }

    // What the capacity search found. Present only for a capacity run, so every
    // other report renders exactly as it did before the mode existed.
    if (extras.has_capacity) {
        json_report["capacity"] = extras.capacity;
    }

    // Which operations of the bound contract this run exercised, and which of
    // their declared responses it saw (issue #629). Computed against the
    // document `metadata.openapi` names - the one the run was *planned* with -
    // and stored at run end, so a binding that has since synced to a newer spec
    // cannot rewrite what an old report says was covered. Absent for every run
    // that was not measured against a contract; see ReportExtras::coverage.
    if (!extras.coverage.empty ()) {
        json_report["coverage"] = extras.coverage;
    }

    // Whether the responses this run kept matched the schemas that same
    // document declares (issue #682). Beside `coverage` because they answer
    // halves of one question - which of the contract was exercised, and whether
    // what came back honoured it - but on different evidence: coverage counts
    // every send, this checks the bounded reservoir the run stored. The
    // `sampled` count rides along so a reader cannot mistake one for the other.
    // Absent for every run that checked nothing; see ReportExtras.
    if (!extras.schema_validation.empty ()) {
        json_report["schemaValidation"] = extras.schema_validation;
    }

    // The aggregate verdict, beside the per-response one. `verdict` is derived
    // rather than stored so it cannot contradict the counts printed next to it.
    if (extras.has_thresholds) {
        json_report["thresholdValidation"] = { { "checks", extras.threshold_checks },
            { "passed", extras.thresholds_passed }, { "failed", extras.thresholds_failed },
            { "verdict", extras.thresholds_failed == 0 ? "passed" : "failed" } };
    }

    // When the run's credential was renewed under it, and what stopped a
    // renewal that did not happen. A run whose token expired mid-flight shows
    // up as 401s in the status distribution; this is the section that says why.
    if (extras.has_auth) {
        nlohmann::json auth = { { "refreshes", extras.auth_refreshes },
            { "refreshFailures", extras.auth_refresh_failures } };
        if (!extras.auth_last_error.empty ()) {
            auth["lastError"] = extras.auth_last_error;
        }
        json_report["auth"] = auth;
    }
}

/** The measured half of the report, section by section. */
nlohmann::json build_report_body (const vayu::DetailedReport& report,
const ReportExtras& extras,
double target_rps) {
    nlohmann::json json_report;
    json_report["summary"] = { { "totalRequests", report.total_requests },
        { "successfulRequests", report.successful_requests },
        { "failedRequests", report.failed_requests }, { "errorRate", report.error_rate },
        { "totalDurationSeconds", report.total_duration_s },
        { "avgRps", report.avg_rps }, { "testDuration", report.total_duration_s },
        { "sendRate", report.send_rate }, { "throughput", report.throughput },
        { "setupOverhead", report.setup_overhead_s },
        { "peakConcurrency", static_cast<size_t> (extras.peak_concurrency) },
        { "droppedRequests", static_cast<size_t> (extras.dropped_total) },
        { "avgQueueWaitMs", extras.queue_wait_avg },
        { "bytesSent", static_cast<size_t> (extras.bytes_sent) },
        { "bytesReceived", static_cast<size_t> (extras.bytes_received) },
        // Sits in `summary` rather than `metadata.configuration` on purpose:
        // configuration is what was asked for, and this is what happened.
        // LoadTestDetail reads both and only trusts the requested-protocol
        // label when this is 0.
        { "httpVersionDowngraded", static_cast<size_t> (extras.http_version_downgraded) },
        { "throughputBytesPerSec",
        report.total_duration_s > 0 ? extras.bytes_received / report.total_duration_s : 0.0 } };
    json_report["latency"] = { { "min", report.latency_min }, { "max", report.latency_max },
        { "avg", report.latency_avg }, { "median", report.latency_p50 },
        { "p50", report.latency_p50 }, { "p75", report.latency_p75 },
        { "p90", report.latency_p90 }, { "p95", report.latency_p95 },
        { "p99", report.latency_p99 }, { "p999", report.latency_p999 } };
    json_report["statusCodes"] = report.status_codes;

    if (target_rps > 0) {
        json_report["rateControl"] = { { "targetRps", report.target_rps },
            { "actualRps", report.actual_rps }, { "achievement", report.rps_achievement } };
    }

    nlohmann::json errors_obj;
    errors_obj["total"]       = report.failed_requests;
    errors_obj["withDetails"] = report.errors_with_details;
    errors_obj["types"]       = report.error_types;
    if (!report.errors_by_status_code.empty ()) {
        errors_obj["byStatusCode"] = report.errors_by_status_code;
    }
    json_report["errors"] = errors_obj;

    // Two independent halves under one key, and either can be present without
    // the other. The averages come from the retained trace sample, so they are
    // absent for a run that stored no traces; `phases` comes from the
    // histograms every completion fed, so it is present for a run that stored
    // none and absent for one recorded before the bank existed. Clients read
    // each half by its own key rather than treating the object's presence as
    // proof of either.
    nlohmann::json timing_breakdown = nlohmann::json::object ();
    if (report.has_timing_data) {
        timing_breakdown["avgDnsMs"]       = report.avg_dns_ms;
        timing_breakdown["avgConnectMs"]   = report.avg_connect_ms;
        timing_breakdown["avgTlsMs"]       = report.avg_tls_ms;
        timing_breakdown["avgFirstByteMs"] = report.avg_first_byte_ms;
        timing_breakdown["avgDownloadMs"]  = report.avg_download_ms;
    }
    if (!extras.phases.empty ()) {
        timing_breakdown["phases"] = extras.phases;
    }
    if (!timing_breakdown.empty ()) {
        json_report["timingBreakdown"] = timing_breakdown;
    }

    // What this run's streams delivered: the per-completion event distribution,
    // the totals behind it, how many the caps ended, and the derived rate.
    // Absent for every run that did not stream - see ReportExtras::stream.
    if (!extras.stream.empty ()) {
        json_report["stream"] = extras.stream;
    }

    if (report.slow_threshold_ms > 0) {
        json_report["slowRequests"] = { { "count", report.slow_requests_count },
            { "thresholdMs", report.slow_threshold_ms },
            { "percentage",
            report.total_requests > 0 ?
            (static_cast<double> (report.slow_requests_count) * 100.0 /
            static_cast<double> (report.total_requests)) :
            0.0 } };
    }

    // How much each bounded store thinned away. All zeros means the sampled
    // sets below are complete; non-zero means they are a uniform sample of the
    // run (reservoir retention), not its opening.
    if (extras.has_sampling) {
        json_report["sampling"] = { { "errorsDropped", extras.errors_dropped },
            { "successTracesDropped", extras.success_traces_dropped },
            { "slowTracesDropped", extras.slow_traces_dropped },
            { "responseSamplesDropped", extras.response_samples_dropped },
            { "exemplarsDropped", extras.exemplars_dropped },
            { "sampleBodiesDropped", extras.sample_bodies_dropped },
            { "responseBodiesCaptured", extras.response_bodies_captured } };
    }

    add_optional_report_sections (extras, json_report);
    return json_report;
}

/**
 * A sample of the run's own exchanges. The row id travels so a client can ask
 * `GET /runs/:id/samples` for the captured bodies, which deliberately do not
 * ride this payload (see run_samples_response).
 */
nlohmann::json build_report_results (const std::vector<vayu::db::Result>& results) {
    // Include sample of request/response results
    nlohmann::json results_array = nlohmann::json::array ();
    size_t max_results           = 100;
    size_t count                 = 0;
    for (const auto& result : results) {
        if (count >= max_results)
            break;
        nlohmann::json result_obj;
        // The row id, and the only way a client can ask GET /runs/:id/samples
        // for this sample's captured exchange - the bodies deliberately do not
        // travel on this payload (see run_samples_response).
        result_obj["id"]         = result.id;
        result_obj["timestamp"]  = result.timestamp;
        result_obj["statusCode"] = result.status_code;
        result_obj["statusText"] = result.status_text;
        result_obj["latencyMs"]  = result.latency_ms;
        if (!result.error.empty ())
            result_obj["error"] = result.error;
        if (!result.trace_data.empty ()) {
            try {
                result_obj["trace"] = nlohmann::json::parse (result.trace_data);
            } catch (...) {
                result_obj["trace"] = result.trace_data;
            }
        }
        results_array.push_back (result_obj);
        count++;
    }
    return results_array;
}

/**
 * Testable core of GET /runs/:id/report, returning {http_status, json_body}. A
 * missing run is a definitive 404 in the shared `{"error": {"code", "message"}}`
 * shape.
 *
 * The whole-run aggregates come from `runs.summary` - the values the run itself
 * computed at completion - laid over a report calculated from the run's sampled
 * `results`. A run with no summary never reached a terminal status (the engine
 * died mid-run), and reports from those sampled results alone rather than
 * erroring. Either way a report is one run row plus its sampled results.
 *
 * Extracted so the wiring is covered without an in-process HTTP server - see
 * runs_route_test.cpp. Exceptions propagate to the route's try/catch (500).
 */
std::pair<int, nlohmann::json>
run_report_response (vayu::db::Database& db, const std::string& run_id) {
    auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    auto results = db.get_results (run_id);

    double duration_s = 0;
    if (run->start_time > 0) {
        int64_t end = run->end_time > 0 ? run->end_time : now_ms ();
        duration_s  = static_cast<double> (end - run->start_time) / 1000.0;
    }

    auto report =
    vayu::utils::MetricsHelper::calculate_detailed_report (results, duration_s);

    // No usable summary now means one thing only: the engine died before this
    // run reached a terminal status, so it never wrote one. The report then
    // stands on the sampled `results` alone - `calculate_detailed_report`
    // above - rather than erroring.
    ReportExtras extras;
    apply_run_summary (run->summary, report, extras);

    const double target_rps =
    reconcile_report_rates (run->config_snapshot, duration_s, extras, report);

    nlohmann::json json_report = build_report_body (report, extras, target_rps);
    json_report["metadata"]    = build_report_metadata (run_id, *run);
    json_report["results"]     = build_report_results (results);

    return { 200, json_report };
}

namespace {

void handle_list_runs (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const bool wants_envelope = req.has_param ("limit") ||
    req.has_param ("offset") || req.has_param ("type") || req.has_param ("status") ||
    req.has_param ("requestId") || req.has_param ("collectionId") ||
    req.has_param ("q") || req.has_param ("baseline");

    if (!wants_envelope) {
        // Legacy no-param path: today's bare array, byte-shape-identical.
        vayu::utils::log_info ("GET /runs - Fetching all runs (legacy)");
        try {
            auto runs                = ctx.db.get_all_runs ();
            nlohmann::json json_runs = nlohmann::json::array ();
            for (const auto& run : runs) {
                json_runs.push_back (vayu::json::serialize (run));
            }
            vayu::utils::log_debug (
            "GET /runs - Returning " + std::to_string (runs.size ()) + " runs");
            res.set_content (json_runs.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /runs - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
        return;
    }

    // Parse + clamp pagination; validate filters (invalid enum -> ignored).
    int64_t limit = 50;
    if (req.has_param ("limit")) {
        try {
            limit = std::stoll (req.get_param_value ("limit"));
        } catch (...) {
            limit = 50;
        }
        if (limit <= 0)
            limit = 50;
        limit = std::min<int64_t> (limit, 500); // Cap page size.
    }
    int64_t offset = 0;
    if (req.has_param ("offset")) {
        try {
            offset = std::stoll (req.get_param_value ("offset"));
        } catch (...) {
            offset = 0;
        }
        offset = std::max<int64_t> (offset, 0);
    }

    vayu::db::RunFilter filter;
    if (req.has_param ("type"))
        filter.type = vayu::parse_run_type (req.get_param_value ("type"));
    if (req.has_param ("status"))
        filter.status = vayu::parse_run_status (req.get_param_value ("status"));
    if (req.has_param ("requestId"))
        filter.request_id = req.get_param_value ("requestId");
    if (req.has_param ("collectionId"))
        filter.collection_id = req.get_param_value ("collectionId");
    if (req.has_param ("q"))
        filter.q = req.get_param_value ("q");
    // Only the two spellings that mean something are honoured; anything
    // else leaves the filter unset, matching how an invalid `type` or
    // `status` is ignored rather than answered with a 400.
    if (req.has_param ("baseline")) {
        const std::string value = req.get_param_value ("baseline");
        if (value == "true")
            filter.baseline = true;
        else if (value == "false")
            filter.baseline = false;
    }

    // Debug, not info: this is the polled endpoint, and at the production
    // verbosity the app spawns the engine with (`--verbose 1`) an info line
    // here was flushed to stdout every 5s, through a pipe the Electron main
    // process reads, splits and logs - a third process woken per tick by an
    // idle app (#1150). The file sink defaults to `debug`, so the line is not
    // lost, only taken off the console's poll cadence.
    vayu::utils::log_debug ("GET /runs - Listing runs (limit=" + std::to_string (limit) +
    ", offset=" + std::to_string (offset) + ")");
    try {
        auto [status, body] =
        get_runs_response (ctx.db, filter, limit, offset, ctx.run_summary_cache);
        res.status = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error ("GET /runs - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_get_run (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info ("GET /runs/:id - Fetching run: " + run_id);
    try {
        auto run = ctx.db.get_run (run_id);
        if (run) {
            vayu::utils::log_debug ("GET /runs/:id - Found run: " + run_id +
            ", type=" + to_string (run->type) + ", status=" + to_string (run->status));
            auto payload = vayu::json::serialize (*run);
            // A design run is one exchange, so it travels with the run.
            // Load runs keep theirs in the report, where `results` means
            // the sampled subset. Guard here, before fetching - a load
            // run's results are not bounded (one row per error, uncapped)
            // and must never be pulled just to be discarded.
            if (run->type == vayu::RunType::Design)
                vayu::json::attach_design_result (
                payload, *run, ctx.db.get_results (run_id));
            res.set_content (payload.dump (), "application/json");
        } else {
            vayu::utils::log_warning ("GET /runs/:id - Run not found: " + run_id);
            send_error (res, 404, "Run not found");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "GET /runs/:id - Error fetching run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_delete_run (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info ("DELETE /runs/:id - Deleting run: " + run_id);
    try {
        auto [status, body] =
        delete_run_response (ctx.db, ctx.run_manager, run_id, DELETE_STOP_WAIT_MS);
        res.status = status;
        res.set_content (body.dump (), "application/json");
        if (status == 200) {
            vayu::utils::log_info (
            "DELETE /runs/:id - Successfully deleted run: " + run_id);
        } else if (status == 404) {
            vayu::utils::log_warning ("DELETE /runs/:id - Run not found: " + run_id);
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "DELETE /runs/:id - Error deleting run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_set_baseline (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info ("PUT /runs/:id/baseline - Run: " + run_id);
    try {
        auto [status, body] = set_run_baseline_response (ctx.db, run_id, req.body);
        res.status = status;
        res.set_content (body.dump (), "application/json");
        if (status == 404) {
            vayu::utils::log_warning (
            "PUT /runs/:id/baseline - Run not found: " + run_id);
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "PUT /runs/:id/baseline - Error for run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_stop_run (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info ("POST /runs/:id/stop - Stopping run: " + run_id);
    try {
        auto run = ctx.db.get_run (run_id);
        if (!run) {
            vayu::utils::log_warning ("POST /runs/:id/stop - Run not found: " + run_id);
            send_error (res, 404, "Run not found");
            return;
        }

        // Check if run is already completed or stopped
        if (run->status == vayu::RunStatus::Completed ||
        run->status == vayu::RunStatus::Stopped || run->status == vayu::RunStatus::Failed) {
            vayu::utils::log_info (
            "POST /runs/:id/stop - Run already finished: " + run_id +
            ", status=" + to_string (run->status));
            auto response = vayu::utils::MetricsHelper::create_already_stopped_response (
            run_id, to_string (run->status));
            res.set_content (response.dump (), "application/json");
            return;
        }

        // A streaming design run is stopped by asking its consumer worker
        // to end the transfer (issue #573). Checked before the load-run
        // path because a design run has no `RunContext` at all: without
        // this it fell through to the not-active branch, which flips the
        // row to Stopped while the worker keeps consuming - a run reported
        // finished that is still holding a socket.
        //
        // The worker owns the terminal write, so the row is left alone
        // here: `record_design_result` sets `Stopped` when it settles,
        // which is also when the trace and the true event count land.
        if (ctx.sse_manager.request_stop (run_id)) {
            vayu::utils::log_info (
            "POST /runs/:id/stop - Signaling stop for stream: " + run_id);
            // Waited on rather than answered immediately, so the caller is
            // told what actually happened - the same budget the load path
            // gives a graceful stop. A transfer notices within one progress
            // callback, so this all but always settles at once.
            auto stream = ctx.sse_manager.get (run_id);
            const auto deadline =
            std::chrono::steady_clock::now () + std::chrono::seconds (5);
            while (stream && !stream->closed () &&
            std::chrono::steady_clock::now () < deadline) {
                std::this_thread::sleep_for (std::chrono::milliseconds (10));
            }
            const bool settled = !stream || stream->closed ();

            nlohmann::json response;
            response["runId"] = run_id;
            response["status"] =
            to_string (settled ? vayu::RunStatus::Stopped : vayu::RunStatus::Running);
            response["message"] =
            settled ? "Stream stopped" : "Stop signalled; the stream has not settled yet";
            if (stream) {
                response["totalEvents"] = stream->total_events ();
            }
            res.set_content (response.dump (), "application/json");
            return;
        }

        // Try to find active run context
        auto context = ctx.run_manager.get_run (run_id);
        if (context) {
            vayu::utils::log_info (
            "POST /runs/:id/stop - Signaling stop for active run: " + run_id);
            // Signal the running thread to stop
            context->should_stop = true;
            // Wake the closed-loop controller for immediate cancellation
            // (otherwise it waits up to its 50ms safety-net timeout).
            context->notify_refill ();

            // Wait for graceful shutdown
            vayu::utils::MetricsHelper::wait_for_graceful_stop (*context, 5);

            // Calculate summary metrics
            auto summary = vayu::utils::MetricsHelper::calculate_summary (*context);
            vayu::utils::log_info ("POST /runs/:id/stop - Run stopped: " + run_id +
            ", total_requests=" + std::to_string (summary.total_requests) +
            ", errors=" + std::to_string (summary.errors));
            auto response =
            vayu::utils::MetricsHelper::create_stop_response (run_id, summary);

            res.set_content (response.dump (), "application/json");
        } else {
            // Run not active, just update DB
            vayu::utils::log_info (
            "POST /runs/:id/stop - Run not active, updating DB: " + run_id);
            ctx.db.update_run_status_with_retry (run_id, vayu::RunStatus::Stopped);

            auto response = vayu::utils::MetricsHelper::create_inactive_response (run_id);
            res.set_content (response.dump (), "application/json");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "POST /runs/:id/stop - Error stopping run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_get_run_report (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info (
    "GET /runs/:id/report - Generating report for run: " + run_id);
    try {
        auto [status, body] = run_report_response (ctx.db, run_id);
        if (status == 404) {
            vayu::utils::log_warning ("GET /runs/:id/report - Run not found: " + run_id);
        }
        res.status = status;
        res.set_content (body.dump (2), "application/json");
    } catch (const std::exception& e) {
        send_error (res, 500, e.what ());
    }
}

void handle_get_run_samples (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info (
    "GET /runs/:id/samples - Fetching captured samples for run: " + run_id);

    int64_t limit = 50;
    if (req.has_param ("limit")) {
        try {
            limit = std::stoll (req.get_param_value ("limit"));
        } catch (...) {
            limit = 50;
        }
        if (limit <= 0)
            limit = 50;
        limit = std::min<int64_t> (limit, 500); // Cap page size, as GET /runs does.
    }
    int64_t offset = 0;
    if (req.has_param ("offset")) {
        try {
            offset = std::stoll (req.get_param_value ("offset"));
        } catch (...) {
            offset = 0;
        }
        offset = std::max<int64_t> (offset, 0);
    }

    try {
        auto [status, body] = run_samples_response (ctx.db, run_id, limit, offset);
        if (status == 404) {
            vayu::utils::log_warning (
            "GET /runs/:id/samples - Run not found: " + run_id);
        }
        res.status = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "GET /runs/:id/samples - Error for run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

} // namespace

void register_run_routes (RouteContext& ctx) {
    /**
     * GET /runs?limit=&offset=&type=&status=&requestId=&collectionId=&q=
     * Lists test runs (both "design" single requests and "load" tests), newest
     * first. Rows carry a compact `summary` (url/method/mode/duration/
     * concurrency/comment/httpVersion/followRedirects/maxRedirects) instead of
     * the full config_snapshot, wrapped in the `{data, pagination}` envelope.
     * See build_run_summary for the authoritative key list - keep this in step
     * with it. A design run's row also carries `resultSummary`
     * (statusCode + latencyMs); see get_runs_response.
     *
     * Query params:
     * - limit: page size, default 50, capped at 500
     * - offset: rows to skip, floored at 0
     * - type: "design" | "load" (invalid -> ignored)
     * - status: RunStatus string (invalid -> ignored)
     * - requestId: exact match
     * - collectionId: exact match against a scenario run's stored
     *   `scenario.collectionId`. Only a collection run records one, so a design
     *   or load run never matches; an id nothing ran is an empty page, not an
     *   error.
     * - q: case-insensitive substring over the stored config_snapshot text
     * - baseline: "true" lists only pinned baselines, "false" only unpinned
     *   ones; any other value is ignored, like an invalid type/status
     *
     * Back-compat (removed next minor): a request with *no* query params at all
     * returns the legacy bare array of full-configSnapshot rows unchanged, so
     * external scripts keep working. Any recognised param opts into the envelope.
     */
    ctx.server.Get ("/runs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_list_runs (ctx, req, res);
    });

    /**
     * GET /runs/:runId  (alias: GET /run/:runId, deprecated)
     * Retrieves details for a specific test run by its ID.
     */
    httplib::Server::Handler get_run = [&ctx] (const httplib::Request& req,
                                       httplib::Response& res) {
        handle_get_run (ctx, req, res);
    };
    ctx.server.Get (R"(/runs/([^/]+))", get_run);
    ctx.server.Get (R"(/run/([^/]+))", deprecated_alias (get_run));

    /**
     * DELETE /runs/:runId  (alias: DELETE /run/:runId, deprecated)
     * Deletes a specific test run and all associated metrics/results. An active
     * run is stopped first and only deleted once its worker has settled; see
     * delete_run_response.
     */
    httplib::Server::Handler delete_run = [&ctx] (const httplib::Request& req,
                                          httplib::Response& res) {
        handle_delete_run (ctx, req, res);
    };
    ctx.server.Delete (R"(/runs/([^/]+))", delete_run);
    ctx.server.Delete (R"(/run/([^/]+))", deprecated_alias (delete_run));

    /**
     * PUT /runs/:runId/baseline  - body {"baseline": true|false}
     * Pins or unpins a run as a baseline: the known-good run later runs are
     * compared against, and the one run retention will not expire. Answers the
     * updated list row; 404 when no such run, 400 on a body that does not carry
     * a boolean `baseline`. No deprecated alias - the endpoint is new.
     */
    ctx.server.Put (R"(/runs/([^/]+)/baseline)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_set_baseline (ctx, req, res);
    });

    /**
     * POST /runs/:runId/stop  (alias: POST /run/:runId/stop, deprecated)
     * Stops a running load test.
     */
    httplib::Server::Handler stop_run = [&ctx] (const httplib::Request& req,
                                        httplib::Response& res) {
        handle_stop_run (ctx, req, res);
    };
    ctx.server.Post (R"(/runs/([^/]+)/stop)", stop_run);
    ctx.server.Post (R"(/run/([^/]+)/stop)", deprecated_alias (stop_run));

    /**
     * GET /runs/:runId/report  (alias: GET /run/:runId/report, deprecated)
     * Retrieves a detailed statistical report for a specific test run.
     */
    httplib::Server::Handler get_run_report = [&ctx] (const httplib::Request& req,
                                              httplib::Response& res) {
        handle_get_run_report (ctx, req, res);
    };
    ctx.server.Get (R"(/runs/([^/]+)/report)", get_run_report);
    ctx.server.Get (R"(/run/([^/]+)/report)", deprecated_alias (get_run_report));

    /**
     * GET /runs/:runId/samples?limit=&offset=
     * The response headers and body captured for this run's retained samples -
     * every error, the slow outliers, and the first few of each status code.
     *
     * Its own endpoint rather than more fields on the report: the report loads
     * and parses every result row for a run on each fetch, and the dashboard
     * polls it. This is fetched only when a reader expands a sample.
     *
     * No deprecated `/run/...` alias - the endpoint is new, so there is no
     * pre-consolidation spelling for it to keep working.
     */
    ctx.server.Get (R"(/runs/([^/]+)/samples)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_get_run_samples (ctx, req, res);
    });
}

} // namespace vayu::http::routes
