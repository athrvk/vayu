/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Run management and reporting routes. */

#include "vayu/core/load_strategy.hpp"
#include "vayu/core/mcp_error_counts.hpp"
#include "vayu/core/run_result_summary.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/metrics_helper.hpp"
#include "vayu/utils/parse.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <expected>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <utility>

namespace vayu::http::routes {

namespace {

// How long POST /runs/:id/stop waits for an active run's worker to settle
// before answering.
constexpr int STOP_GRACE_SECONDS = 5;

// How long DELETE /runs/:id waits for an active run's worker to settle before
// refusing: the stop's budget, so stop-then-delete sees one budget.
constexpr int64_t DELETE_STOP_WAIT_MS = int64_t{ STOP_GRACE_SECONDS } * 1000;

// Copy src[key] to dst[key] when present and not null. Shared by the list-row
// `summary` builder and the report route's `config_obj` (which adds a few
// renamed keys on top) so the two extract config fields the same way.
void add_if_present (nlohmann::json& dst, const nlohmann::json& src, const char* key) {
    if (src.contains (key) && !src[key].is_null ())
        dst[key] = src[key];
}

// The run's open-loop rate, recorded as `targetRps`. The POST /runs body names
// it `rps` or `targetRps`; the list row and the report both expose the one name
// and record the rate the run paced at, which `requested_rps`
// (load_strategy.cpp) decides: `rps` unless it is absent, null or zero, then
// `targetRps`. A zero `rps` with no `targetRps` is recorded as the zero it was.
void add_target_rps (nlohmann::json& dst, const nlohmann::json& src) {
    const auto present = [&src] (const char* key) -> const nlohmann::json* {
        const auto it = src.find (key);
        return it == src.end () || it->is_null () ? nullptr : &*it;
    };
    const nlohmann::json* rps    = present ("rps");
    const nlohmann::json* target = present ("targetRps");
    const bool rps_paces         = rps != nullptr && *rps != 0;
    const nlohmann::json* rate = rps_paces || target == nullptr ? rps : target;
    if (rate != nullptr)
        dst["targetRps"] = *rate;
}

// Always present, unlike `add_if_present`'s keys: a POST /runs body's
// `"httpVersion": null` lands in config_snapshot verbatim (the snapshot is
// built from the raw body before `normalize_run_http_version` erases the key),
// and an older run has no key. Neither recorded a protocol, so both read "auto"
// rather than an omission that would say the value was lost. "auto" means the
// snapshot names none, not that auto was chosen. Never
// `src["httpVersion"].get<std::string> ()` here: an explicit null throws.
void add_http_version (nlohmann::json& dst, const nlohmann::json& src) {
    if (src.contains ("httpVersion") && !src["httpVersion"].is_null ()) {
        dst["httpVersion"] = src["httpVersion"];
    } else {
        dst["httpVersion"] = "auto";
    }
}

// One run-scoped default-header decision (`acceptEncoding`, #1488;
// `expectContinue`, #2516) from the snapshot's nested `defaultHeaders`, nested
// so it cannot collide with a client-controlled top-level key `add_if_present`
// copies. Omitted, not defaulted, when the snapshot predates it: unlike
// httpVersion, absent means no decision was recorded. Only the app's baseline
// comparison reads absent as false, which is what every earlier run sent.
void add_default_header_flag (nlohmann::json& dst, const nlohmann::json& src, const char* key) {
    if (!src.contains ("defaultHeaders") || !src["defaultHeaders"].is_object ()) {
        return;
    }
    const auto& headers = src["defaultHeaders"];
    if (headers.contains (key) && headers[key].is_boolean ()) {
        dst[key] = headers[key];
    }
}

// A scenario run's list-row descriptor; absent for another snapshot. A
// collection run has no `url` or `method`, so without it the history sidebar
// draws a bare status and timestamp; a row needs which collection ran, how big
// the run was and which data file drove it (#2051). `stepCount`, not the
// manifest's `steps` (a name, method and URL per step), which would undo the
// reason `summary` exists; the array stays on `GET /runs/:id`.
void add_scenario (nlohmann::json& dst, const nlohmann::json& src) {
    if (!src.contains ("scenario") || !src["scenario"].is_object ()) {
        return;
    }
    const auto& scenario = src["scenario"];

    nlohmann::json row = nlohmann::json::object ();
    for (const char* key : { "collectionId", "iterations", "recursive",
         "dataFileName", "dataFileHash", "dataFileCastNumbers" }) {
        add_if_present (row, scenario, key);
    }
    if (scenario.contains ("steps") && scenario["steps"].is_array ()) {
        row["stepCount"] = scenario["steps"].size ();
    }
    if (!row.empty ()) {
        dst["scenario"] = std::move (row);
    }
}

// The compact list-row summary: the seventeen keys the history and dashboard
// lists read (`targetRps` is `rps` renamed, see `add_target_rps`), each omitted
// when absent from the snapshot except httpVersion (`add_http_version`), plus
// `acceptEncoding` (#1488) and a collection run's `scenario`, both omitted
// rather than defaulted. `dataFileName` / `dataFileHash` (#2051) and
// `dataFileCastNumbers` (#2540) are a single-request run's; a collection run's
// ride `scenario`. `startConcurrency` / `rampUpDuration` (#1935) are listed so
// a row agrees with the report's `configuration` (`build_run_report_config`). A
// malformed snapshot yields an empty object, never an error. Builds the list
// rows and the PUT /runs/:id/baseline row; GET /runs/:id returns the full
// snapshot. `hasWarnings` (#1527) is a completion-time fact, not part of the
// immutable snapshot, so it is never built or cached here: `get_runs_response`
// merges it into the (possibly cached) row.
//
// `requestName` is the name as the client sent it, never re-read from the
// requests table: the trust model of `url` and `method` (this function joins
// nothing, so an edited name would disagree anyway), and why it comes from the
// client at all: Send executes editor state, whose name may be unsaved or
// belong to a since-deleted request. `execIdentity` (the app's
// `execute-mapping.ts`) threads it through composition; without a name a
// history row falls back to a bare URL.
nlohmann::json build_run_summary (const std::string& config_snapshot) {
    nlohmann::json summary = nlohmann::json::object ();
    try {
        auto config = nlohmann::json::parse (config_snapshot);
        if (config.is_object ()) {
            for (const char* key : { "url", "method", "mode", "duration",
                 "concurrency", "iterations", "startConcurrency", "rampUpDuration",
                 "comment", "followRedirects", "maxRedirects", "requestName",
                 "dataFileName", "dataFileHash", "dataFileCastNumbers" }) {
                add_if_present (summary, config, key);
            }
            add_target_rps (summary, config);
            add_http_version (summary, config);
            add_default_header_flag (summary, config, "acceptEncoding");
            add_scenario (summary, config);
        }
    } catch (...) {
        // @deliberate: a malformed snapshot reads as an empty summary, never a
        // 500 - the run happened, and its report is not the place to relitigate
        // what was stored beside it.
    }
    return summary;
}

// The stored-summary readers the report shares with the list row's
// `resultSummary` (`core/run_result_summary.hpp`).
using vayu::core::assertion_totals_json;
using vayu::core::copy_optional_number;
using vayu::core::drain_cut_json;
using vayu::core::read_capacity_headline;
using vayu::core::read_drain_cut;
using vayu::core::read_number;
using vayu::core::read_run_assertions;
using vayu::core::read_status_codes;
using vayu::core::read_threshold_outcome;
using vayu::core::run_assertions_json;
using vayu::core::RunAssertions;
using vayu::core::StoredThresholds;

// What a run submitted, what its mode set out to submit (0 for an open-ended
// one), and the window it submitted in, off the stored summary (#2392).
struct SendingTotals {
    size_t requests_sent      = 0;
    size_t requests_expected  = 0;
    double sending_duration_s = 0.0;
    // Completions inside that window (#2882); empty for an older summary, which
    // leaves `summary.completedWhileSending` out rather than reporting none.
    std::optional<size_t> completed_while_sending;
};

// Report fields that live outside the DetailedReport struct: whole-run counters
// the report injects into its `summary` object. Filled from the run's stored
// summary, or a live load run's collector (apply_live_counters).
//
// `optin.performance.Padding` is right that size-ordering these fields would
// save 48 bytes, and the trade is refused deliberately: the layout is by report
// section - each `has_*` flag sits with the block it gates and the paragraph
// explaining why absent is not zero - and size order interleaves all six
// sections, leaving every comment describing fields that no longer follow it.
// One of these exists per `GET /runs/:id/report` call, on the stack, so the
// 48 bytes buy nothing measurable; the grouping is read by everyone who touches
// the report. Revisit if this is ever held per run or per result.
// NOLINTNEXTLINE(clang-analyzer-optin.performance.Padding)
struct ReportExtras {
    // The run's totals are its last persisted tick's, stored by
    // `reconcile_orphaned_runs` for a run the engine died under (#2895), or
    // there is no summary at all where a failed load run should have one.
    // Each becomes a `summary` flag only when true.
    bool summary_partial    = false;
    bool summary_missing    = false;
    double peak_concurrency = 0.0;
    double dropped_total    = 0.0;
    // The pacer's deliberate skips and the schedule time they cover (#2911);
    // 0 for a run stored before them, which skipped nothing.
    double skipped_total  = 0.0;
    double stalled_ms     = 0.0;
    double queue_wait_avg = 0.0;
    double bytes_sent     = 0.0;
    double bytes_received = 0.0;
    // True once an authoritative status-code distribution replaced the one
    // derived from the sampled results - only then are successful/failed
    // recounted from it (a run with neither keeps the sampled figures).
    bool status_codes_overridden = false;
    // A sequential collection run (`RunType::Scenario`; a scenario load run is
    // `Load`). It feeds no `MetricsCollector`, so the report omits the
    // load-only figures, and its stored `status_codes` is authoritative even
    // when empty (#2822).
    bool sequential_run = false;
    // False when the stored summary timed nothing (`latency.count` of 0: a
    // collection run where no step sent), for a live load run, whose
    // percentiles cannot be read yet, and for a `partial` or missing summary
    // (#2938), whose rows were never flushed or are a sample. The report then
    // leaves `latency` out: its zero defaults would read as instant answers. A
    // summary with no `count` (every load run, and older collection runs) keeps
    // the block.
    bool latency_measured = true;
    // Script-validation tallies; `has_tests` false leaves the report's
    // testValidation section out entirely.
    bool has_tests    = false;
    int tests_sampled = 0;
    int tests_passed  = 0;
    int tests_failed  = 0;
    // What the replayed scripts logged (#3127), as stored: `[{level, text}]`.
    // Empty leaves `console` out of the section.
    nlohmann::json tests_console = nlohmann::json::array ();
    size_t tests_console_dropped = 0;
    // The verdict against the run's declared budgets. Empty for a run that
    // declared none (or predates budgets) leaves thresholdValidation out: it
    // was never judged, not zero checks passed.
    std::optional<StoredThresholds> thresholds;
    // This run's `metric.record` / `pm.metrics` values (#1500); false for none
    // leaves `customMetrics` out rather than an empty object.
    bool has_custom_metrics       = false;
    nlohmann::json custom_metrics = nlohmann::json::object ();
    // Whether the run's OAuth 2.0 credential was refreshed while it ran. False
    // is a run that could not refresh (no oauth2, a non-expiring or
    // query-placed token, an engine older than mid-run refresh), not one that
    // never needed to, so the section is left out rather than reporting zero
    // refreshes.
    bool has_auth                 = false;
    nlohmann::json auth_refreshes = nlohmann::json::array ();
    size_t auth_refresh_failures  = 0;
    std::string auth_last_error;
    // A capacity run's search result, in the report's camelCase shape. False
    // for every other mode: a fixed target measured a point, not a curve, and a
    // knee of zero would name a limit nothing observed.
    bool has_capacity       = false;
    nlohmann::json capacity = nlohmann::json::object ();
    // What a streaming run's completions delivered, verbatim: the producer
    // writes the report's names, and re-keying would be a second place to keep
    // them (#576). Empty for a non-streaming run, which leaves the section out
    // rather than reporting an event rate of zero.
    nlohmann::json stream = nlohmann::json::object ();
    // What the run's bounded stores thinned away. False is a run recorded
    // before retention was reported, not one that dropped nothing, so the
    // section is left out rather than shown as zeros.
    bool has_sampling               = false;
    size_t errors_dropped           = 0;
    size_t success_traces_dropped   = 0;
    size_t slow_traces_dropped      = 0;
    size_t response_samples_dropped = 0;
    size_t exemplars_dropped        = 0;
    size_t sample_bodies_dropped    = 0;
    // Whether the response-sample byte budget ended a sample, separating a
    // still-uniform tested set from one drawn from where bodies fit (#1192).
    // Empty for an older summary, which leaves the key out: "not spent" would
    // be a claim about a run nothing looked at.
    std::optional<bool> response_sample_budget_spent;
    // A scenario run's tallies, from the summary's `scenario`. False leaves the
    // section out rather than showing a load run four zeros.
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
    // Design-mode scenario runs only, from a summary that records them (#2526):
    // absent stays absent, not "nothing lost" about a run nothing counted, nor
    // a setting an older run never had.
    std::optional<size_t> steps_not_run;
    std::optional<bool> stop_on_error;
    // Design-mode scenario runs only, from a summary that records them (#3397):
    // the steps a Stop cut short, the fifth outcome beside the four.
    std::optional<size_t> steps_stopped;
    // Load-mode scenario runs only. `virtual_users` is what `concurrency`
    // meant; `iterations_abandoned` counts iterations a step with no response
    // (or an unhonourable jump) ended before the plan's last step, which
    // explains a breakdown thinning towards the end.
    size_t virtual_users        = 0;
    size_t iterations_abandoned = 0;
    // Per-step latency and counts, verbatim from the summary. Empty for a
    // design-mode run, which reports its steps as `results[]` rows instead.
    nlohmann::json step_breakdown = nlohmann::json::array ();
    // Every `control.transaction` that closed at least once (#1515),
    // `{ name, count, errors, latency }`, verbatim from the summary both run
    // modes write (`scenario_runner.cpp`, `scenario_load.cpp`). Empty when no
    // transaction element ran or its folder never closed.
    nlohmann::json transactions = nlohmann::json::array ();
    // A scenario load run's completed passes (#3570), `{count, mean, min, p50,
    // p95, p99, max}` in ms, verbatim from the summary. Empty for a design-mode
    // run, a load run with no completed pass, and one stored before #3570.
    nlohmann::json pass_duration = nlohmann::json::object ();
    // The load run's assertion block (#3537), the report's `assertions`; its
    // `exact` is also a scenario load run's `scenario.assertions` (#2820).
    // Empty for a run that asserted nothing and errored nowhere, a sequential
    // collection run, or an older run, which leaves both out rather than
    // reading "0 failed".
    std::optional<RunAssertions> assertions;
    // Non-zero means this run stored response headers and bodies verbatim.
    // Capture does not redact, by decision, so the Samples tab reads this to
    // warn rather than leaving the reader to infer it.
    size_t response_bodies_captured = 0;
    // The server-vitals scrape's record, verbatim (per-series min/max/avg,
    // sample and gap counts). False leaves the section out: a run with no
    // monitor did not measure a target reporting zeros.
    bool has_monitor       = false;
    nlohmann::json monitor = nlohmann::json::object ();
    // Transfers that asked for HTTP/2 and negotiated something older: not a
    // performance number, it tells whether the report's protocol label is the
    // one the numbers were measured over (#215).
    double http_version_downgraded = 0.0;
    // Requests libcurl re-sent on a new connection after a reused one was
    // dropped or refused (#2799). Empty for an older summary:
    // `summary.connectionReplays` is left out, not reported as none.
    std::optional<size_t> connection_replays;
    // Mean requests in flight over the run (#2821). Empty for a summary stored
    // before the key existed, which leaves `summary.avgInFlight` out rather
    // than reporting an older run as one that sent nothing.
    std::optional<double> avg_in_flight;
    // Requests a user Stop cancelled (#2136): sent, never answered, in neither
    // `totalRequests` nor an error count. Only the stored summary knows it (the
    // status distribution never held them); an older run reads 0.
    size_t cancelled_requests = 0;
    // The part of `cancelled_requests` a Stop cut from the drain of a run
    // that ended on its own (#3538), the report's `summary.drainCut`. Empty
    // for every other run, which leaves the key out.
    std::optional<size_t> drain_cut;
    // The run's failed `mcp` replies by class (#3828), already in the
    // report's `summary.errorClasses` shape. Empty for a summary stored before
    // the key existed, which leaves it out rather than claiming none failed.
    std::optional<nlohmann::json> error_classes;
    // Per-phase latency distributions, verbatim in the report's shape. Empty
    // for a run that recorded none (the toggle off, nothing successful, an
    // engine older than the phase bank) leaves `timingBreakdown.phases` out.
    // Each phase's `mean` also feeds the averages beside it
    // (`apply_summary_phase_means`), so where stored the two describe the same
    // completions.
    nlohmann::json phases = nlohmann::json::object ();
    // Which bound-contract operations the run exercised (#629), verbatim (the
    // producer writes the report's camelCase, as for `stream` / `monitor`).
    // Empty for a run measured against no contract (an unbound collection, a
    // single-request run, a document predating the operation index) leaves the
    // section out: a run never judged did not fail one.
    nlohmann::json coverage = nlohmann::json::object ();
    // What checking the sampled responses against that contract found (#682),
    // verbatim on `coverage`'s terms. Empty for a run that validated nothing
    // (an unbound collection, a single-request run, a document with no response
    // schemas) leaves the section out: unchecked responses did not pass.
    // Sampled where `coverage` is exact; the block says so.
    nlohmann::json schema_validation = nlohmann::json::object ();
    // `script.setup` / `script.teardown` outcomes (issue #1499), passed
    // through verbatim on the same terms as `coverage`. Empty for a run whose
    // collection declared neither, or a single-request run, which has no
    // collection to declare them on.
    nlohmann::json lifecycle = nlohmann::json::object ();
    // A single-request run's `requestElements` outcomes (#1594), verbatim in
    // the report's `{id, kind, passed, failed, skipped, deferred}` shape, the
    // sibling of a scenario's `scenario.steps[].elements` (`step_breakdown`).
    // Never both: `run_manager.cpp` writes this key only on the branch with no
    // `scenario_state`. Empty for every scenario run and every single-request
    // run that declared or ran none.
    nlohmann::json elements = nlohmann::json::array ();
    // What the run did not do (#1503): a request sent with an unresolved
    // `{{token}}`, a step whose pre-request script this mode never ran.
    // Verbatim in the report's shape; empty leaves the key out rather than an
    // empty array on every run.
    nlohmann::json warnings = nlohmann::json::array ();
    // Empty for a summary predating #2392, which keeps the old rate-fidelity
    // formula and leaves `summary.sendingDurationSeconds` and `rateControl`'s
    // two counts out rather than zero.
    std::optional<SendingTotals> sending;
};

// An optional boolean, so a key an older engine never wrote stays absent rather
// than `false`. A number reads as nothing on purpose: a malformed value is not
// a recording.
void read_optional_bool (const nlohmann::json& obj, const char* key, std::optional<bool>& out) {
    if (obj.contains (key) && obj[key].is_boolean ()) {
        out = obj[key].get<bool> ();
    }
}

// A stored `capacity` section (snake_case, like every stored section) in the
// report's camelCase shape. Every field is optional: `max_healthy_*` is absent
// when the first level already breached, `knee_*` when the search ended for a
// reason other than latency or errors, `saturation_*` when it did not end on a
// plateau, and an older summary has none of them (nor the error share, #2815,
// nor a level's `samples`, #2926: absent there, never 0, as 0 says p99 measured
// nothing). Only a section carrying the levels it measured is reported, the
// thresholds rule: an empty one says nothing actionable.
void read_capacity_section (const nlohmann::json& stored, ReportExtras& extras) {
    auto headline = read_capacity_headline (stored);
    if (!headline) {
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
        nlohmann::json reported = { { "concurrency", concurrency },
            { "rps", rps }, { "p99Ms", p99_ms } };
        copy_optional_number (level, "error_pct", reported, "errorPct");
        copy_optional_number (level, "samples", reported, "samples");
        levels.push_back (std::move (reported));
    }

    nlohmann::json capacity = std::move (*headline);
    double slo_ms           = 0.0;
    read_number (stored, "slo_ms", slo_ms);
    capacity["sloMs"] = slo_ms;
    copy_optional_number (stored, "max_error_pct", capacity, "maxErrorPct");
    capacity["levels"] = levels;

    if (capacity.contains ("maxHealthyConcurrency")) {
        double rps    = 0.0;
        double p99_ms = 0.0;
        read_number (stored, "max_healthy_rps", rps);
        read_number (stored, "p99_at_max_healthy_ms", p99_ms);
        capacity["maxHealthyRps"]     = rps;
        capacity["p99AtMaxHealthyMs"] = p99_ms;
    }
    if (capacity.contains ("kneeConcurrency")) {
        double p99_ms = 0.0;
        read_number (stored, "knee_p99_ms", p99_ms);
        capacity["kneeP99Ms"] = p99_ms;
        copy_optional_number (stored, "knee_error_pct", capacity, "kneeErrorPct");
    }
    if (stored.contains ("saturation_concurrency")) {
        size_t concurrency = 0;
        double rps         = 0.0;
        double p99_ms      = 0.0;
        read_number (stored, "saturation_concurrency", concurrency);
        read_number (stored, "saturation_rps", rps);
        read_number (stored, "saturation_p99_ms", p99_ms);
        capacity["saturationConcurrency"] = concurrency;
        capacity["saturationRps"]         = rps;
        capacity["saturationP99Ms"]       = p99_ms;
    }

    extras.has_capacity = true;
    extras.capacity     = std::move (capacity);
}

/** The stored summary's whole-run `latency` block, or the marker that nothing was timed. */
void apply_summary_latency (const nlohmann::json& summary,
vayu::DetailedReport& report,
ReportExtras& extras) {
    if (!summary.contains ("latency") || !summary["latency"].is_object ()) {
        return;
    }
    const auto& latency = summary["latency"];
    if (latency.contains ("count") && latency["count"] == 0) {
        extras.latency_measured = false;
        return;
    }
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

/**
 * The setup and cleanup overheads (#2894). A summary with no
 * `cleanup_overhead` was stored before the two were split, and its
 * `setup_overhead` measured cleanup: it is reported as that, and the setup
 * figure is left out rather than given a number nobody measured. A summary
 * with neither key is the sequential collection run's, whose report omits
 * both (`add_load_summary_fields`).
 */
void apply_summary_overheads (const nlohmann::json& summary, vayu::DetailedReport& report) {
    if (summary.contains ("cleanup_overhead")) {
        read_number (summary, "cleanup_overhead", report.cleanup_overhead_s);
        double setup_s = 0.0;
        read_number (summary, "setup_overhead", setup_s);
        report.setup_overhead_s = setup_s;
        return;
    }
    if (summary.contains ("setup_overhead")) {
        read_number (summary, "setup_overhead", report.cleanup_overhead_s);
        report.setup_overhead_s.reset ();
    }
}

/** The whole-run totals and the latency distribution. */
void apply_summary_totals (const nlohmann::json& summary,
vayu::DetailedReport& report,
ReportExtras& extras) {
    read_number (summary, "total_requests", report.total_requests);
    read_number (summary, "cancelled", extras.cancelled_requests);
    extras.drain_cut = read_drain_cut (summary);
    read_number (summary, "send_rate", report.send_rate);
    read_number (summary, "throughput", report.throughput);
    read_number (summary, "test_duration", report.total_duration_s);
    apply_summary_overheads (summary, report);
    if (summary.contains ("rps") && summary["rps"].is_number ()) {
        report.avg_rps    = summary["rps"].get<double> ();
        report.actual_rps = report.avg_rps;
    }

    read_number (summary, "peak_concurrency", extras.peak_concurrency);
    if (summary.contains ("avg_in_flight") && summary["avg_in_flight"].is_number ()) {
        extras.avg_in_flight = summary["avg_in_flight"].get<double> ();
    }
    read_number (summary, "dropped_requests", extras.dropped_total);
    read_number (summary, "skipped_requests", extras.skipped_total);
    read_number (summary, "stalled_ms", extras.stalled_ms);
    read_number (summary, "queue_wait_avg", extras.queue_wait_avg);
    read_number (summary, "bytes_sent", extras.bytes_sent);
    read_number (summary, "bytes_received", extras.bytes_received);
    read_number (summary, "http_version_downgraded", extras.http_version_downgraded);
    if (summary.contains ("connection_replays") &&
    summary["connection_replays"].is_number ()) {
        extras.connection_replays = summary["connection_replays"].get<size_t> ();
    }
    // Written together (#2392), so one key stands for the three.
    if (summary.contains ("sending_duration") && summary["sending_duration"].is_number ()) {
        SendingTotals sending;
        read_number (summary, "sending_duration", sending.sending_duration_s);
        read_number (summary, "requests_sent", sending.requests_sent);
        read_number (summary, "requests_expected", sending.requests_expected);
        if (summary.contains ("completed_while_sending") &&
        summary["completed_while_sending"].is_number ()) {
            sending.completed_while_sending =
            summary["completed_while_sending"].get<size_t> ();
        }
        extras.sending = sending;
    }

    apply_summary_latency (summary, report, extras);
}

/**
 * The run's exact slow count (#2399), over the one counted from its stored
 * traces. Key-absent is a run stored before the count existed or one that
 * measured nothing, and keeps the trace count; a stored 0 is a measured 0.
 */
void apply_summary_slow_requests (const nlohmann::json& summary, vayu::DetailedReport& report) {
    if (!summary.contains ("slow_requests") || !summary["slow_requests"].is_object ()) {
        return;
    }
    const auto& slow = summary["slow_requests"];
    read_number (slow, "count", report.slow_requests_count);
    read_number (slow, "thresholdMs", report.slow_threshold_ms);
}

/// One phase's stored whole-run `mean`, or nothing when the summary has none.
std::optional<double> stored_phase_mean (const nlohmann::json& phases, const char* phase) {
    const auto entry = phases.find (phase);
    if (entry == phases.end () || !entry->is_object ()) {
        return std::nullopt;
    }
    const auto mean = entry->find ("mean");
    if (mean == entry->end () || !mean->is_number ()) {
        return std::nullopt;
    }
    return mean->get<double> ();
}

/**
 * The report's `timingBreakdown.avg*Ms` from each phase's whole-run `mean`
 * (#2782), every successful completion's, over the retained trace sample's
 * that the sampled results computed. All five or none: a summary without them
 * (the phase bank off, or a run stored before the means) keeps the sample's.
 */
void apply_summary_phase_means (const nlohmann::json& summary, vayu::DetailedReport& report) {
    if (!summary.contains ("phases") || !summary["phases"].is_object ()) {
        return;
    }
    using vayu::core::TimingPhase;
    std::array<double, vayu::core::TIMING_PHASE_COUNT> means{};
    for (size_t i = 0; i < means.size (); ++i) {
        const auto mean =
        stored_phase_mean (summary["phases"], vayu::core::TIMING_PHASE_KEYS.at (i));
        if (!mean) {
            return;
        }
        means.at (i) = *mean;
    }
    report.has_timing_data = true;
    report.avg_dns_ms      = means.at (static_cast<size_t> (TimingPhase::Dns));
    report.avg_connect_ms = means.at (static_cast<size_t> (TimingPhase::Connect));
    report.avg_tls_ms = means.at (static_cast<size_t> (TimingPhase::Tls));
    report.avg_first_byte_ms = means.at (static_cast<size_t> (TimingPhase::FirstByte));
    report.avg_download_ms = means.at (static_cast<size_t> (TimingPhase::Download));
}

/**
 * The run's exact per-type error counts (#2400), over the ones counted from its
 * stored error records, which stop at `maxStoredErrors`. Key-absent is a run
 * stored before the counts existed, or a design-mode collection run, which
 * writes none; either keeps the record count. `errors.withDetails` stays the
 * stored-record count either way.
 */
void apply_summary_error_types (const nlohmann::json& summary, vayu::DetailedReport& report) {
    if (!summary.contains ("error_types") || !summary["error_types"].is_object ()) {
        return;
    }
    report.error_types.clear ();
    for (const auto& [type, count] : summary["error_types"].items ()) {
        if (count.is_number_unsigned () && count.get<size_t> () > 0) {
            report.error_types[type] = count.get<size_t> ();
        }
    }
}

/// The positive counts of @p from, by key; anything else in it is skipped.
nlohmann::json positive_counts (const nlohmann::json& from) {
    nlohmann::json counts = nlohmann::json::object ();
    for (const auto& [key, count] : from.items ()) {
        if (count.is_number_unsigned () && count.get<size_t> () > 0) {
            counts[key] = count;
        }
    }
    return counts;
}

/**
 * The run's failed `mcp` replies by class (#3828), as `McpErrorCounts::to_json`
 * stored them: the three classes and `protocolCodes`, each kept only as a
 * positive count. Key-absent is a run stored before the counts existed, which
 * leaves `summary.errorClasses` out.
 */
void apply_summary_error_classes (const nlohmann::json& summary, ReportExtras& extras) {
    const auto stored = summary.find ("error_classes");
    if (stored == summary.end () || !stored->is_object ()) {
        return;
    }
    nlohmann::json classes = nlohmann::json::object ();
    for (const std::string_view name : core::MCP_ERROR_CLASS_NAMES) {
        if (const auto count = stored->find (name); count != stored->end () &&
        count->is_number_unsigned () && count->get<size_t> () > 0) {
            classes[std::string (name)] = *count;
        }
    }
    if (const auto codes = stored->find ("protocolCodes");
    codes != stored->end () && codes->is_object ()) {
        if (auto counted = positive_counts (*codes); !counted.empty ()) {
            classes["protocolCodes"] = std::move (counted);
        }
    }
    extras.error_classes = std::move (classes);
}

/**
 * The status-code map, which replaces the sampled one wholesale when stored.
 * An empty map keeps the sampled one, except on a sequential collection run:
 * there `{}` is a run in which no step sent, and its rows hold a status-0 row
 * for every skipped step that would otherwise count as a failure. A summary
 * stored before that run wrote the key keeps the rows (#2822).
 */
void apply_summary_status_codes (const nlohmann::json& summary,
vayu::DetailedReport& report,
ReportExtras& extras) {
    if (!summary.contains ("status_codes") || !summary["status_codes"].is_object ()) {
        return;
    }
    const auto& codes = summary["status_codes"];
    if (codes.empty () && !extras.sequential_run) {
        return;
    }
    report.status_codes            = read_status_codes (codes);
    extras.status_codes_overridden = true;
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
        read_optional_bool (sampling, "response_sample_budget_spent",
        extras.response_sample_budget_spent);
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
        if (scenario.contains ("steps_not_run") && scenario["steps_not_run"].is_number ()) {
            extras.steps_not_run = scenario["steps_not_run"].get<size_t> ();
        }
        if (scenario.contains ("stopped") && scenario["stopped"].is_number ()) {
            extras.steps_stopped = scenario["stopped"].get<size_t> ();
        }
        read_optional_bool (scenario, "stop_on_error", extras.stop_on_error);
        // Load-mode only: the design-mode runner writes neither, and a load run
        // stores no per-step `results` rows, so the breakdown is its only
        // per-step record.
        read_number (scenario, "virtual_users", extras.virtual_users);
        read_number (scenario, "iterations_abandoned", extras.iterations_abandoned);
        if (scenario.contains ("steps") && scenario["steps"].is_array ()) {
            extras.step_breakdown = scenario["steps"];
        }
        if (scenario.contains ("transactions") && scenario["transactions"].is_array ()) {
            extras.transactions = scenario["transactions"];
        }
        if (scenario.contains ("pass_duration") && scenario["pass_duration"].is_object ()) {
            extras.pass_duration = scenario["pass_duration"];
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
        if (const auto console = summary["tests"].find ("console");
        console != summary["tests"].end () && console->is_array ()) {
            extras.tests_console = *console;
        }
        read_number (summary["tests"], "consoleDropped", extras.tests_console_dropped);
    }
    extras.assertions = read_run_assertions (summary);

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
 * The sections stored in the report's wire shape and passed through, not
 * re-keyed: the producer writes the report's names, so a translation table
 * would be a second place to keep them. An empty section is absent: it names
 * nothing a reader can act on.
 */
void apply_summary_sections (const nlohmann::json& summary, ReportExtras& extras) {
    // Per-phase distributions (`TIMING_PHASE_KEYS`).
    if (summary.contains ("phases") && summary["phases"].is_object () &&
    !summary["phases"].empty ()) {
        extras.phases = summary["phases"];
    }

    // Same pass-through, same empty-is-absent rule (issue #576).
    if (summary.contains ("stream") && summary["stream"].is_object () &&
    !summary["stream"].empty ()) {
        extras.stream = summary["stream"];
    }

    // Contract coverage (#629): an object with no `operations` array is absent,
    // as `thresholds` treats one with no `checks`.
    if (summary.contains ("coverage") && summary["coverage"].is_object () &&
    summary["coverage"].contains ("operations") &&
    summary["coverage"]["operations"].is_array () &&
    !summary["coverage"]["operations"].empty ()) {
        extras.coverage = summary["coverage"];
    }

    // `script.setup` / `script.teardown` (#1499): the producer writes
    // `{setup?, teardown?}`, each only when that phase ran an element, so an
    // empty object is a run whose collection declared neither.
    if (summary.contains ("lifecycle") && summary["lifecycle"].is_object () &&
    !summary["lifecycle"].empty ()) {
        extras.lifecycle = summary["lifecycle"];
    }

    // A single-request run's step-level elements (#1594, #1641): the array is
    // the section; absent or empty is a run that declared none, or a scenario
    // run, which reports them under `scenario.steps[].elements`.
    if (summary.contains ("elements") && summary["elements"].is_array () &&
    !summary["elements"].empty ()) {
        extras.elements = summary["elements"];
    }

    // Sampled schema validation (#682): a block with no `sampled` count says
    // nothing actionable and cannot honestly be labelled a sample, so it is
    // absent.
    if (summary.contains ("schemaValidation") && summary["schemaValidation"].is_object () &&
    summary["schemaValidation"].contains ("sampled") &&
    summary["schemaValidation"]["sampled"].is_number () &&
    summary["schemaValidation"]["sampled"].get<size_t> () > 0) {
        extras.schema_validation = summary["schemaValidation"];
    }

    // #1503: absent or empty is a run with nothing to report, not one shown a
    // warning nobody wrote.
    if (summary.contains ("warnings") && summary["warnings"].is_array () &&
    !summary["warnings"].empty ()) {
        extras.warnings = summary["warnings"];
    }

    extras.thresholds = read_threshold_outcome (summary);

    // In the shape both run modes write (`build_custom_metrics_payload`,
    // #1500); an empty object is a run with no custom metric, absent as for
    // `coverage`.
    if (summary.contains ("customMetrics") &&
    summary["customMetrics"].is_object () && !summary["customMetrics"].empty ()) {
        extras.has_custom_metrics = true;
        extras.custom_metrics     = summary["customMetrics"];
    }
}

/**
 * Applies the run's stored `summary` (the whole-run results, written once at
 * terminal status) over the report computed from the sampled `results`. An
 * absent or unreadable summary leaves the sampled report as it is: there is no
 * second source. Keys are `vayu::core::build_run_summary_payload`'s, and
 * `runs_route_report_summary_test.cpp` round-trips the pair so they cannot
 * drift.
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
        vayu::utils::log_warning ("run",
        "Run summary is not valid JSON; reporting "
        "from the sampled results alone");
        return;
    }
    if (!summary.is_object ()) {
        vayu::utils::log_warning ("run",
        "Run summary is not an object; reporting "
        "from the sampled results alone");
        return;
    }

    std::optional<bool> partial;
    read_optional_bool (summary, "partial", partial);
    extras.summary_partial = partial.value_or (false);
    apply_summary_totals (summary, report, extras);
    apply_summary_slow_requests (summary, report);
    apply_summary_phase_means (summary, report);
    apply_summary_error_types (summary, report);
    apply_summary_error_classes (summary, extras);
    apply_summary_status_codes (summary, report, extras);
    apply_summary_sampling (summary, extras);
    apply_summary_scenario (summary, extras);
    apply_summary_observations (summary, extras);
    apply_summary_sections (summary, extras);
}

// One run as a list row: identity, status and the compact summary, never the
// full config_snapshot (that keeps the list cheap), in the camelCase keys
// `vayu::json::serialize (Run)` emits. The caller supplies the summary: the
// polled list from the run-summary cache, the unpolled one-row baseline
// response built directly.
nlohmann::json serialize_run_row (const vayu::db::Run& run, nlohmann::json summary) {
    nlohmann::json row;
    row["id"]        = run.id;
    row["type"]      = vayu::to_string (run.type);
    row["status"]    = vayu::to_string (run.status);
    row["startTime"] = run.start_time;
    row["endTime"]   = vayu::json::serialize_run_end_time (run);
    row["requestId"] = run.request_id.has_value () ? nlohmann::json (*run.request_id) :
                                                     nlohmann::json (nullptr);
    row["environmentId"] = run.environment_id.has_value () ?
    nlohmann::json (*run.environment_id) :
    nlohmann::json (nullptr);
    row["baseline"]      = run.baseline;
    row["origin"]        = vayu::json::serialize_run_origin (run);
    // Absent, never null, on a row with no verdict (#3547).
    if (run.outcome) {
        row["outcome"] = *run.outcome;
    }
    row["summary"] = std::move (summary);
    return row;
}

// `<startTime>:<id>`, split on the first ':' because the time is an integer
// and an id may hold one. A cursor names a row, so an empty id is malformed.
std::optional<vayu::db::RunCursor> parse_run_cursor (std::string_view text) {
    const auto colon = text.find (':');
    if (colon == std::string_view::npos) {
        return std::nullopt;
    }
    const auto start_time = vayu::utils::parse_number<int64_t> (text.substr (0, colon));
    const auto id = text.substr (colon + 1);
    if (!start_time || id.empty ()) {
        return std::nullopt;
    }
    return vayu::db::RunCursor{ .start_time = *start_time, .id = std::string (id) };
}

std::string run_cursor_text (const vayu::db::Run& run) {
    return std::to_string (run.start_time) + ":" + run.id;
}

// One row past @p limit, so the caller reads `hasMore` off the rows: a cursor
// page has no offset to add to `total`, and `total` is counted under its own
// lock acquisition, so a run started in between would skew the sum anyway.
std::expected<std::vector<vayu::db::Run>, RouteError> fetch_runs_page (vayu::db::Database& db,
const vayu::db::RunFilter& filter,
int64_t limit,
int64_t offset,
const std::optional<std::string>& before) {
    if (!before) {
        return db.get_runs_paginated (filter, limit + 1, offset);
    }
    if (offset != 0) {
        return route_error (400, "'before' and a non-zero 'offset' cannot be combined: a cursor page starts after the row it names",
        "before_with_offset");
    }
    const auto cursor = parse_run_cursor (*before);
    if (!cursor) {
        return route_error (400, "'before' must be '<startTime>:<id>', as pagination.nextBefore spells it",
        "invalid_before");
    }
    return db.get_runs_before (filter, *cursor, limit + 1);
}

} // namespace

/**
 * Testable core of the paginated GET /runs list, {http_status, json_body}. No
 * rows is a valid list, not a 404; the one refusal is a `before` that is
 * malformed (`invalid_before`) or beside a non-zero offset
 * (`before_with_offset`), both 400.
 *
 * `limit` / `offset` arrive parsed and clamped (limit default 50, capped at
 * 500; offset floored at 0), `filter` validated. `before` is the raw keyset
 * cursor (#2978): the page starts after the row it names, and
 * `pagination.nextBefore` names this page's last row whenever `hasMore`. Rows
 * carry the compact `summary` (`build_run_summary`) instead of
 * `config_snapshot`, in GET /runs/:id/metrics' `{data, pagination}` envelope
 * (#86). A design run's row also carries `resultSummary` (statusCode,
 * latencyMs), a terminal load run's its own (rps, p95Ms, errorRate, verdict,
 * the assertion counts or a single-request run's failed count, capacity, each
 * when recorded; #2130, #3458), a terminal collection run's its step counts and
 * verdict (#2954): what a reader would otherwise fetch a report per row for. A
 * run that finished with warnings carries `summary.hasWarnings: true` (#1527),
 * read off this page's `Run` rows, not through `summaries` (see the call site).
 *
 * `summaries` spares the 5s history poll from re-parsing every row's immutable
 * `config_snapshot` to rebuild what the last call built (#1150); a terminal
 * load run's stored summary is as fixed. It is a parameter so the caller (a
 * test included) owns the cache's lifetime and two never share one. Exceptions
 * propagate to the route's try/catch (500); `runs_route_test.cpp` covers the
 * envelope, clamping and filtering.
 */
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter,
int64_t limit,
int64_t offset,
vayu::http::RunSummaryCache& summaries,
const std::optional<std::string>& before) {
    auto page = fetch_runs_page (db, filter, limit, offset, before);
    if (!page) {
        return as_response (page.error ());
    }
    auto& runs          = *page;
    const bool has_more = std::cmp_greater (runs.size (), limit);
    if (has_more) {
        runs.pop_back ();
    }
    const int64_t total = db.count_runs (filter);

    // A design run is one exchange, so its outcome fits on its row for one
    // extra query per page (`get_design_result_outcomes`). A load run's results
    // are unbounded and never read here; a load or collection row's
    // `resultSummary` comes from the whole-run summary on the `Run` row.
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
        // `has_warnings` is a completion-time fact
        // (`Database::update_run_summary` stamps it) and the summary cache keys
        // on the immutable `config_snapshot`, so it is read off this page's
        // `Run` row and merged into this call's copy, never the cache entry: a
        // row polled while running is not stuck without warnings once it
        // finishes (#1527).
        if (run.has_warnings) {
            row["summary"]["hasWarnings"] = true;
        }
        if (const auto found = outcomes.find (run.id); found != outcomes.end ()) {
            row["resultSummary"]["statusCode"] = found->second.status_code;
            row["resultSummary"]["latencyMs"]  = found->second.latency_ms;
        }
        if (vayu::core::carries_result_summary (run)) {
            auto outcome = summaries.outcome_for (run.id,
            [&run] { return vayu::core::terminal_result_summary (run); });
            if (!outcome.empty ()) {
                row["resultSummary"] = std::move (outcome);
            }
        }
        data.push_back (std::move (row));
    }

    nlohmann::json response;
    response["data"]                     = std::move (data);
    response["pagination"]["total"]      = total;
    response["pagination"]["limit"]      = limit;
    response["pagination"]["offset"]     = offset;
    response["pagination"]["hasMore"]    = has_more;
    response["pagination"]["returned"]   = runs.size ();
    response["pagination"]["nextBefore"] = has_more && !runs.empty () ?
    nlohmann::json (run_cursor_text (runs.back ())) :
    nlohmann::json (nullptr);
    return { 200, response };
}

namespace {

/// A stored sample body as GET /runs/:id/samples answers it: the stored bytes,
/// and the `body` / `bodyEncoding` pair they travel as.
struct SampleBody {
    std::string bytes;
    std::string body;
    std::string_view encoding;
};

/// Capture classes a body as text from its first `SNIFF_BYTES` alone, and a
/// JSON string holds only UTF-8, so a byte past that window that is not text
/// sends the whole body as base64, as an inbox capture does (#3159). A body
/// the per-body cap cut can end inside a character; that tail is left off the
/// text rather than sending the prefix as base64 (`response_body_text`).
SampleBody classify_sample_body (std::string bytes, bool truncated) {
    const std::string_view text = truncated ?
    vayu::utils::without_incomplete_utf8_tail (bytes) :
    std::string_view (bytes);
    if (vayu::utils::is_valid_utf8_text (text)) {
        std::string body (text);
        return { std::move (bytes), std::move (body), vayu::json::BODY_ENCODING_UTF8 };
    }
    std::string body = vayu::utils::base64_encode (bytes);
    return { std::move (bytes), std::move (body), vayu::json::BODY_ENCODING_BASE64 };
}

/// Keyed by truncation as well as blob: only a truncated row's tail is trimmed,
/// so one blob can read differently under two rows.
using SampleBodyCache = std::map<std::pair<int, bool>, SampleBody>;

/// Bodies are deduplicated in storage, so a page of 50 samples of the same
/// response points at one blob: it is read and classified once, not 50 times.
const SampleBody& cached_sample_body (vayu::db::Database& db,
SampleBodyCache& cache,
const vayu::db::ResultBody& row) {
    const auto key = std::pair{ row.blob_id, row.truncated };
    if (const auto cached = cache.find (key); cached != cache.end ()) {
        return cached->second;
    }
    SampleBody classified =
    classify_sample_body (db.get_body_blob_content (row.blob_id), row.truncated);
    return cache.emplace (key, std::move (classified)).first->second;
}

/// A page's sample rows share a few `streamTextPath`s (one per streaming step
/// at most), so each is compiled once per page.
using TextPathCache =
std::map<std::string, std::shared_ptr<const vayu::StreamTextPath>, std::less<>>;

/// @p source compiled through @p cache; null for a row that stored none.
std::shared_ptr<const vayu::StreamTextPath> stream_text_path_of (TextPathCache& cache,
const std::optional<std::string>& source) {
    if (!source) {
        return nullptr;
    }
    if (const auto cached = cache.find (*source); cached != cache.end ()) {
        return cached->second;
    }
    auto compiled = vayu::http::compile_stream_text_path (*source);
    cache.emplace (*source, compiled);
    return compiled;
}

} // namespace

/**
 * Testable core of GET /runs/:id/samples, {http_status, json_body}. A missing
 * run is a 404 in the shared error shape; a run that captured nothing is an
 * empty page.
 *
 * Not an extension of the report's `results[]`: that path parses every row's
 * `trace_data` for aggregates that never read a body, and the dashboard polls
 * it, so bodies there would turn a ~200-byte row read into megabytes per poll.
 * The exchanges live in their own tables, fetched per page only when a reader
 * expands a sample. `limit` / `offset` arrive parsed and clamped; the envelope
 * is GET /runs' `{data, pagination}`.
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

    // Once per page, not per streamed row: the caps are the reader's settings
    // now, and rows bounded by two rules would make a page nobody could
    // describe.
    const vayu::http::SseLimits sse_limits = vayu::http::read_sse_limits (db);

    SampleBodyCache body_cache;
    TextPathCache text_paths;

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
            const SampleBody& stored = cached_sample_body (db, body_cache, row);
            response["body"]         = stored.body;
            response["bodyEncoding"] = stored.encoding;
            if (row.truncated) {
                // Same convention design-mode traces use (cap_trace_bodies), so
                // a reader has one rule for "this is a slice".
                response["bodyTruncated"] = true;
            }
            // A streamed sample's events, parsed back from its stored body
            // (#657). Absent unless the row recorded a wire event count, so a
            // non-stream or older row carries no `events` node, not an empty
            // one. Derived, not stored twice: the body is the event list, and
            // two copies of one fact drift.
            if (row.stream_events) {
                const auto text_path =
                stream_text_path_of (text_paths, row.stream_text_path);
                response["events"] = vayu::http::buffered_stream_events_node (
                stored.bytes, sse_limits, *row.stream_events, !row.truncated,
                std::nullopt, text_path ? &text_path->steps : nullptr);
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

// A capacity run's two knobs as started (#2925): `stepDuration` as the parser
// read it (string or number), `sloMs` the budget. Gated on the mode, not
// presence, so another mode never reports a knob it ignores; absent when left
// at its default (the effective SLO is the report's `capacity.sloMs`).
void add_capacity_config (nlohmann::json& dst, const nlohmann::json& src) {
    const auto mode = src.find ("mode");
    if (mode == src.end () || *mode != "capacity") {
        return;
    }
    add_if_present (dst, src, "stepDuration");
    add_if_present (dst, src, "sloMs");
}

/**
 * The GET /runs/:runId/report `configuration` object, from a parsed
 * config_snapshot: the load-test knobs, httpVersion / followRedirects /
 * maxRedirects, what a data-driven run bound and the budgets it carried, a
 * capacity run's `stepDuration` and `sloMs` (#2925) and, when stored,
 * `acceptEncoding` (#1488) and `expectContinue` (#2516). `rps` / `targetRps` is
 * the one rename (`add_target_rps`), applied by the caller. `expectContinue` is
 * not in the list row (`build_run_summary`): only the report's comparison reads
 * it. Covered directly by `runs_route_report_test.cpp`.
 */
nlohmann::json build_run_report_config (const nlohmann::json& config) {
    nlohmann::json config_obj = nlohmann::json::object ();
    for (const char* key : { "mode", "duration", "concurrency", "iterations", "startConcurrency",
         "rampUpDuration", "timeout", "comment", "followRedirects", "maxRedirects",
         // The bound data set's size (#993): the snapshot keeps the count in
         // place of the never-persisted rows, and the dashboard's run metadata
         // prints it, so "data-driven, over N rows" survives the payload. The
         // file's name and content hash (#2051), never its path, and whether
         // numbers were cast (#2540), which the hash cannot tell.
         "dataRowCount", "dataFileName", "dataFileHash", "dataFileCastNumbers",
         // The metric keys whose budgets were carried over from an earlier
         // run rather than set for this one (issue #2195): the thresholds
         // alone cannot say which is which, so a verdict needs this to.
         "carriedBudgets" }) {
        add_if_present (config_obj, config, key);
    }
    add_capacity_config (config_obj, config);
    add_http_version (config_obj, config);
    add_default_header_flag (config_obj, config, "acceptEncoding");
    add_default_header_flag (config_obj, config, "expectContinue");
    return config_obj;
}

/**
 * Testable core of PUT /runs/:id/baseline, {http_status, json_body}. PUT
 * because it updates an existing run (#95), and its own endpoint because a run
 * has no general update: the engine writes the rest of the row as it runs.
 * `baseline` is required and must be a boolean; `apply_bool_field` ignores a
 * non-boolean, right among many optional fields and wrong here, where ignoring
 * the one field would answer 200 to a request that changed nothing. 200 carries
 * the row in `GET /runs`' shape, so a client patches its cache rather than
 * re-listing.
 */
std::pair<int, nlohmann::json> set_run_baseline_response (vayu::db::Database& db,
const std::string& run_id,
const std::string& body) {
    const auto parsed_body = parse_request_json (body);
    if (!parsed_body) {
        return as_response (parsed_body.error ());
    }
    const nlohmann::json& parsed = *parsed_body;
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
    auto row = serialize_run_row (*updated, build_run_summary (updated->config_snapshot));
    // Same merge as get_runs_response, and for the same reason: this
    // docstring promises the list's own row shape (#1527).
    if (updated->has_warnings) {
        row["summary"]["hasWarnings"] = true;
    }
    return { 200, row };
}

/**
 * Testable core of DELETE /runs/:id, {http_status, json_body}. An active run is
 * stopped first, or its detached worker would keep writing against the id
 * (orphaned rows, a run partly "un-deleting" itself as it finishes): signalled
 * as POST /runs/:id/stop does, then awaited until the worker hands the run to
 * the retained map, which it does after its last database write.
 *
 * A worker unsettled after `stop_wait_ms` gets a 409 and the run stays: a
 * partial delete racing a live writer is the outcome worth refusing. The stop
 * stands, so a retry moments later succeeds. A `running` row with no context
 * (the daemon restarted under it) has no writer and is deleted directly.
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
        "run", "DELETE /runs/:id - Run is active, stopping it first: " + run_id);
        context->request_stop ();

        // retain_run() is the worker's last act, after the final metrics flush
        // and status update, so "no longer active" is the only signal that says
        // every writer is done with this id.
        const auto deadline = std::chrono::steady_clock::now () +
        std::chrono::milliseconds (stop_wait_ms);
        while (run_manager.get_run (run_id) != nullptr) {
            if (std::chrono::steady_clock::now () >= deadline) {
                vayu::utils::log_warning ("run",
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

namespace {

/**
 * A stopped sequential collection run's answer, from the summary its worker
 * stores before clearing `is_running`: the collector it never fed would say
 * zero for a run that sent (#2822). With no summary yet (the grace period ran
 * out, or the write failed) there is nothing true to count, so the answer
 * carries none and points at the report.
 */
nlohmann::json scenario_stop_response (vayu::db::Database& db, const std::string& run_id) {
    using pointer   = nlohmann::json::json_pointer;
    const auto run  = db.get_run (run_id);
    const auto body = run ?
    nlohmann::json::parse (run->summary, nullptr, /*allow_exceptions=*/false) :
    nlohmann::json ();

    nlohmann::json response;
    response["status"] = to_string (run ? run->status : vayu::RunStatus::Running);
    response["runId"] = run_id;
    if (!body.is_object () || !body.contains ("status_codes") ||
    !body["status_codes"].is_object ()) {
        response["message"] = "Stop signalled; read the report";
        return response;
    }

    const auto failures =
    vayu::count_status_failures (read_status_codes (body["status_codes"]));
    response["summary"] = { { "totalRequests", failures.total },
        { "errors", failures.failed },
        { "httpErrors", failures.failed - failures.no_response },
        { "noResponse", failures.no_response }, { "errorRate", failures.error_rate () },
        { "avgLatencyMs", body.value (pointer ("/latency/avg"), 0.0) },
        { "stepsExecuted", body.value (pointer ("/scenario/steps_executed"), size_t{ 0 }) } };
    return response;
}

/**
 * A stopped load run's status (#3341): the stored one once the worker has
 * written it, which `is_running` clearing does not wait for. Until then it is
 * what the Stop will make it, which for a Stop that landed after the strategy
 * returned on its own is nothing: that run still ends by its own verdict, so
 * it is answered as still running.
 */
vayu::RunStatus load_stop_status (vayu::db::Database& db,
const vayu::core::RunContext& context) {
    if (const auto run = db.get_run (context.run_id);
    run && vayu::is_terminal (run->status)) {
        return run->status;
    }
    return context.stop_decides_outcome () ? vayu::RunStatus::Stopped :
                                             vayu::RunStatus::Running;
}

/// The `message` of a Stop answer whose wait ran out before the run settled
/// (#3342), so a `running` status reads as "not yet", never as "not stopped".
std::string grace_expired_message (int grace_seconds) {
    return "Stop signalled; the run had not settled within the " +
    std::to_string (grace_seconds) + "s grace period; read the report";
}

} // namespace

nlohmann::json stop_active_run_response (vayu::db::Database& db,
vayu::core::RunContext& context,
vayu::RunType run_type,
int grace_seconds) {
    const auto& run_id = context.run_id;
    vayu::utils::log_info (
    "run", "POST /runs/:id/stop - Signaling stop for active run: " + run_id);
    context.request_stop ();
    const bool settled =
    vayu::utils::MetricsHelper::wait_for_graceful_stop (context, grace_seconds);

    nlohmann::json response;
    if (run_type == vayu::RunType::Scenario) {
        response = scenario_stop_response (db, run_id);
        vayu::utils::log_info ("run", "Collection run stopped",
        { { "runId", run_id }, { "status", response["status"] },
        { "summaryStored", response.contains ("summary") } });
    } else {
        const auto summary = vayu::utils::MetricsHelper::calculate_summary (context);
        vayu::utils::log_info ("run", "Run stopped",
        { { "runId", run_id }, { "totalRequests", summary.total_requests },
        { "errors", summary.errors }, { "cancelled", summary.cancelled } });
        response = vayu::utils::MetricsHelper::create_stop_response (
        run_id, summary, to_string (load_stop_status (db, context)));
    }
    if (!settled) {
        response["message"] = grace_expired_message (grace_seconds);
    }
    return response;
}

std::pair<int, nlohmann::json> stop_unregistered_run_response (vayu::db::Database& db,
vayu::core::RunManager& run_manager,
const std::string& run_id) {
    vayu::utils::log_info (
    "run", "POST /runs/:id/stop - Run not active, updating DB: " + run_id);
    const auto outcome = db.transition_run_status (run_id,
    { vayu::RunStatus::Pending, vayu::RunStatus::Running }, vayu::RunStatus::Stopped);
    if (!outcome.current) {
        return { 404, error_body (404, "Run not found") };
    }
    if (!outcome.applied) {
        return { 200,
            vayu::utils::MetricsHelper::create_already_stopped_response (
            run_id, to_string (*outcome.current)) };
    }
    // A run that registered after the caller looked for its context, and had
    // moved its row to Running before the move above, is sending: signal it.
    // One that had not is refused its move to Running and ends unsent.
    if (const auto raced = run_manager.get_run (run_id)) {
        raced->request_stop ();
    }
    return { 200, vayu::utils::MetricsHelper::create_inactive_response (run_id) };
}

/**
 * Testable core of DELETE /runs (#2429): "Clear run history", which keeps what
 * retention keeps - pinned baselines and runs still in flight. The deleted ids
 * travel back so a client can close whatever was showing one.
 */
std::pair<int, nlohmann::json> clear_runs_response (vayu::db::Database& db) {
    const auto cleared = db.clear_runs ();
    return { 200,
        nlohmann::json{ { "deleted", cleared.deleted_ids.size () },
        { "keptPinned", cleared.kept_pinned }, { "deletedIds", cleared.deleted_ids } } };
}

/**
 * Rate fidelity as the pacer counts it (#2392): requests sent over requests
 * expected, and the achieved rate over the sending window, which the
 * end-of-run drain is not part of. Leaves the completed-over-wall-time figures
 * alone for a run stored before the window was, and for a mode that expected
 * no count.
 */
void apply_sending_window_rates (const ReportExtras& extras,
double target_rps,
vayu::DetailedReport& report) {
    const auto& sending = extras.sending;
    if (target_rps <= 0 || !sending || sending->sending_duration_s <= 0 ||
    sending->requests_expected == 0) {
        return;
    }
    const auto sent   = static_cast<double> (sending->requests_sent);
    report.actual_rps = sent / sending->sending_duration_s;
    report.rps_achievement =
    sent / static_cast<double> (sending->requests_expected) * 100.0;
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
    // Recounted from the winning distribution, so transport errors (status 0)
    // count; runs with no stored distribution keep the sampled figures.
    if (extras.status_codes_overridden) {
        const auto tally = vayu::count_status_failures (report.status_codes);
        report.successful_requests = tally.total - tally.failed;
        report.failed_requests     = tally.failed;
        report.errors_by_status_code.clear ();
        for (const auto& [code, count] : report.status_codes) {
            if (code == 0 || code >= 400) {
                report.errors_by_status_code[code] = count;
            }
        }
    }

    // From the reconciled split: `calculate_detailed_report`'s rate describes
    // the sampled results, whose successes are thinned and errors capped.
    report.error_rate = report.total_requests > 0 ?
    static_cast<double> (report.failed_requests) * 100.0 /
    static_cast<double> (report.total_requests) :
    0.0;

    // The rate the run asked for, read as `add_target_rps` records it. Not
    // `open_loop_rate`: a stored closed-loop config with a rate predates #2396,
    // and that run was paced or throttled by it.
    double target_rps = 0.0;
    try {
        target_rps = vayu::core::requested_rps (nlohmann::json::parse (config_snapshot));
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
    apply_sending_window_rates (extras, target_rps, report);
    return target_rps;
}

/** What the report says the run *was* - identity, status, and what was asked for. */
nlohmann::json build_report_metadata (const std::string& run_id, const vayu::db::Run& run) {
    nlohmann::json metadata;
    metadata["runId"]     = run_id;
    metadata["runType"]   = vayu::to_string (run.type);
    metadata["status"]    = vayu::to_string (run.status);
    metadata["startTime"] = run.start_time;
    metadata["endTime"]   = vayu::json::serialize_run_end_time (run);

    try {
        auto config = nlohmann::json::parse (run.config_snapshot);
        if (config.contains ("url")) {
            metadata["requestUrl"] = config["url"];
        }
        if (config.contains ("method")) {
            metadata["requestMethod"] = config["method"];
        }
        // The file a single-request run's binary body sent, as the plan
        // checked it (`{fileName, size, sha256}`); a scenario's steps carry
        // theirs on `scenario.steps[].bodyFile` in the snapshot instead.
        if (auto file = config.find ("bodyFile");
        file != config.end () && file->is_object ()) {
            metadata["bodyFile"] = *file;
        }

        // `rps` -> `targetRps` is the one rename, shared with the list row.
        nlohmann::json config_obj = build_run_report_config (config);
        add_target_rps (config_obj, config);

        if (!config_obj.empty ()) {
            metadata["configuration"] = config_obj;
        }

        // Which collection ran, from the snapshot itself (#3569): the top-level
        // `scenario` breakdown needs a stored summary, which a run the engine
        // did not finish never gets. The list row's object, so the two name a
        // run alike.
        add_scenario (metadata, config);

        // The spec the run was planned against (#637), echoed from the
        // manifest's stamp rather than re-read from the collection, whose
        // binding may have moved: a report says what the run was measured
        // against. Absent for an unbound run; #629's coverage block reads it.
        if (auto scenario = config.find ("scenario");
        scenario != config.end () && scenario->is_object ()) {
            if (auto openapi = scenario->find ("openapi");
            openapi != scenario->end () && openapi->is_object ()) {
                metadata["openapi"] = *openapi;
            }
            // A collection run's data file sits in its manifest, not at the
            // snapshot's top level (issue #2051); `configuration` names it for
            // every shape, so a reader looks in one place.
            for (const char* key : { "dataFileName", "dataFileHash", "dataFileCastNumbers" }) {
                if (auto value = scenario->find (key);
                value != scenario->end () && !value->is_null ()) {
                    metadata["configuration"][key] = *value;
                }
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
 * What the sequence did, step by step. `stepsStored` vs `stepsExecuted` is the
 * honest reading of `results[]`: a run whose store filled reports fewer rows
 * than steps, with every non-passing step among them.
 */
nlohmann::json build_scenario_report_section (const ReportExtras& extras) {
    nlohmann::json section = { { "iterations", extras.iterations },
        { "iterationsCompleted", extras.iterations_completed },
        { "stepsExecuted", extras.steps_executed }, { "passed", extras.steps_passed },
        { "failed", extras.steps_failed }, { "skipped", extras.steps_skipped },
        { "errored", extras.steps_errored }, { "stepsStored", extras.steps_stored },
        { "stepsDropped", extras.steps_dropped } };
    if (extras.steps_not_run) {
        section["stepsNotRun"] = *extras.steps_not_run;
    }
    if (extras.stop_on_error) {
        section["stopOnError"] = *extras.stop_on_error;
    }
    if (extras.steps_stopped) {
        section["stopped"] = *extras.steps_stopped;
    }
    // Only when present, so a design-mode run's section keeps the shape the app
    // renders.
    if (extras.virtual_users > 0) {
        section["virtualUsers"]        = extras.virtual_users;
        section["iterationsAbandoned"] = extras.iterations_abandoned;
        if (!extras.pass_duration.empty ()) {
            section["passDuration"] = extras.pass_duration;
        }
    }
    if (!extras.step_breakdown.empty ()) {
        section["steps"] = extras.step_breakdown;
    }
    // Beside `steps`, not in them: a `control.transaction` spans a folder
    // (#1515). Omitted, never `[]`, when none closed, the absent-not-zeros rule
    // of `coverage` and `customMetrics`.
    if (!extras.transactions.empty ()) {
        section["transactions"] = extras.transactions;
    }
    // Beside the step outcomes, never folded into them: those count step
    // executions, this counts assertions. Absent at zero, the stored rule
    // (#2820), though the block's own `exact` is written whenever it is.
    if (const auto& assertions = extras.assertions) {
        if (const auto& exact = assertions->exact; exact && exact->total () > 0) {
            section["assertions"] = assertion_totals_json (*exact);
        }
    }
    return section;
}

/**
 * The sections a run only has if it did the thing they describe: a sequence, a
 * monitored target, tests, a capacity search, a bound contract, thresholds, a
 * credential that was renewed under it.
 */
void add_optional_report_sections (const ReportExtras& extras, nlohmann::json& json_report) {
    // What the run did not do (#1503), above the sections it judges, as
    // `RunEvents` sits above the totals in the app's Overview: a green run and
    // one that sent every request with an unresolved `{{token}}` must not read
    // the same. Absent when there is nothing to report.
    if (!extras.warnings.empty ()) {
        json_report["warnings"] = extras.warnings;
    }

    if (extras.has_scenario) {
        json_report["scenario"] = build_scenario_report_section (extras);
    }

    // Server vitals, as stored: written in the report's shape, so the section
    // has one description, not a writer and a translator.
    if (extras.has_monitor) {
        json_report["monitor"] = extras.monitor;
    }

    if (extras.has_tests) {
        auto& section = json_report["testValidation"];
        section       = { { "samplesTested", extras.tests_sampled },
            { "testsPassed", extras.tests_passed }, { "testsFailed", extras.tests_failed },
            { "successRate",
            extras.tests_sampled > 0 ?
            (static_cast<double> (extras.tests_passed) * 100.0 /
            static_cast<double> (extras.tests_passed + extras.tests_failed)) :
            0.0 } };
        if (!extras.tests_console.empty ()) {
            section["console"] = extras.tests_console;
            if (extras.tests_console_dropped > 0) {
                section["consoleDropped"] = extras.tests_console_dropped;
            }
        }
    }

    // The capacity search's result; only a capacity run has it.
    if (extras.has_capacity) {
        json_report["capacity"] = extras.capacity;
    }

    // Which bound-contract operations ran and which declared responses came
    // back (#629), computed against the document `metadata.openapi` names (the
    // one the run was planned with) and stored at run end, so a later sync
    // cannot rewrite an old report. Absent for a run measured against no
    // contract.
    if (!extras.coverage.empty ()) {
        json_report["coverage"] = extras.coverage;
    }

    // Whether the kept responses matched that document's schemas (#682). Beside
    // `coverage` as the other half of one question (what of the contract ran,
    // and whether the answers honoured it), on other evidence: coverage counts
    // every send, this checks the stored reservoir, and its `sampled` count
    // keeps the two apart. Absent for a run that checked nothing.
    if (!extras.schema_validation.empty ()) {
        json_report["schemaValidation"] = extras.schema_validation;
    }

    // `script.setup` / `script.teardown` outcomes (issue #1499). Absent for
    // every run whose collection declared neither; see ReportExtras::lifecycle.
    if (!extras.lifecycle.empty ()) {
        json_report["lifecycle"] = extras.lifecycle;
    }

    // A single-request run's step-level element outcomes (#1594, #1641); absent
    // for a scenario run (`scenario.steps[].elements`) and a run that declared
    // no `requestElements`.
    if (!extras.elements.empty ()) {
        json_report["elements"] = extras.elements;
    }

    // The aggregate verdict, beside the per-response one.
    if (const auto& thresholds = extras.thresholds) {
        json_report["thresholdValidation"] = { { "checks", thresholds->checks },
            { "passed", thresholds->passed }, { "failed", thresholds->failed },
            { "verdict", thresholds->verdict () } };
    }

    // Every failed check a verdict reads (#3537): both assertion populations,
    // the element executions that errored and the failed teardowns. Absent for
    // a run that recorded none of them.
    if (const auto& assertions = extras.assertions) {
        json_report["assertions"] = run_assertions_json (*assertions);
    }

    // This run's custom trends, counters and rates (issue #1500), by name -
    // absent for a run that recorded none.
    if (extras.has_custom_metrics) {
        json_report["customMetrics"] = extras.custom_metrics;
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

/**
 * The `summary` figures only a load run measures: the shared collector's rates,
 * bytes and concurrency, and the overheads around load. A sequential collection
 * run feeds none of them (`ScenarioSummaryInputs::latencies` says why), so its
 * report leaves them out rather than writing a 0 that reads as measured (#2822).
 * A run the engine could not fully record (`summary_partial`, `summary_missing`)
 * has no peak concurrency or queue wait either: a tick does not carry them and
 * no summary means none was kept, so they are left out the same way (#2963).
 */
void add_load_summary_fields (const vayu::DetailedReport& report,
const ReportExtras& extras,
nlohmann::json& summary) {
    summary.update ({ { "sendRate", report.send_rate },
    { "throughput", report.throughput }, { "cleanupOverhead", report.cleanup_overhead_s },
    { "droppedRequests", static_cast<size_t> (extras.dropped_total) },
    { "skippedRequests", static_cast<size_t> (extras.skipped_total) },
    { "stalledMs", extras.stalled_ms },
    { "bytesSent", static_cast<size_t> (extras.bytes_sent) },
    { "bytesReceived", static_cast<size_t> (extras.bytes_received) },
    { "throughputBytesPerSec",
    report.total_duration_s > 0 ? extras.bytes_received / report.total_duration_s : 0.0 } });
    if (const auto& setup_overhead = report.setup_overhead_s) {
        summary["setupOverhead"] = *setup_overhead;
    }
    if (!extras.summary_partial && !extras.summary_missing) {
        summary["peakConcurrency"] = static_cast<size_t> (extras.peak_concurrency);
        summary["avgQueueWaitMs"] = extras.queue_wait_avg;
    }
}

/** The measured half of the report, section by section. */
nlohmann::json build_report_body (const vayu::DetailedReport& report,
const ReportExtras& extras,
double target_rps) {
    // `failed_requests` is this tally's `failed` on both report paths, so the
    // breakdown below always sums to it.
    const auto failures = vayu::count_status_failures (report.status_codes);
    nlohmann::json json_report;
    json_report["summary"] = { { "totalRequests", report.total_requests },
        { "successfulRequests", report.successful_requests },
        { "failedRequests", report.failed_requests },
        { "httpErrorRequests", failures.http_errors () },
        { "noResponseRequests", failures.no_response },
        { "cancelledRequests", extras.cancelled_requests },
        { "errorRate", report.error_rate },
        { "totalDurationSeconds", report.total_duration_s },
        { "avgRps", report.avg_rps }, { "testDuration", report.total_duration_s },
        // In `summary`, not `metadata.configuration`: configuration is what was
        // asked, this what happened. LoadTestDetail trusts the
        // requested-protocol label only when this is 0, the app's "none
        // recorded", so a sequential run keeps it too.
        { "httpVersionDowngraded", static_cast<size_t> (extras.http_version_downgraded) } };
    if (!extras.sequential_run) {
        add_load_summary_fields (report, extras, json_report["summary"]);
    }
    if (const auto& sending = extras.sending) {
        json_report["summary"]["sendingDurationSeconds"] = sending->sending_duration_s;
        if (const auto& completed = sending->completed_while_sending) {
            json_report["summary"]["completedWhileSending"] = *completed;
        }
    }
    if (const auto& replays = extras.connection_replays) {
        json_report["summary"]["connectionReplays"] = *replays;
    }
    if (const auto& avg_in_flight = extras.avg_in_flight) {
        json_report["summary"]["avgInFlight"] = *avg_in_flight;
    }
    if (const auto& drain_cut = extras.drain_cut) {
        json_report["summary"]["drainCut"] = drain_cut_json (*drain_cut);
    }
    if (const auto& error_classes = extras.error_classes) {
        json_report["summary"]["errorClasses"] = *error_classes;
    }
    if (extras.summary_partial) {
        json_report["summary"]["partial"] = true;
    }
    if (extras.summary_missing) {
        json_report["summary"]["summaryMissing"] = true;
    }
    if (extras.latency_measured) {
        json_report["latency"] = { { "min", report.latency_min },
            { "max", report.latency_max }, { "avg", report.latency_avg },
            { "median", report.latency_p50 }, { "p50", report.latency_p50 },
            { "p75", report.latency_p75 }, { "p90", report.latency_p90 },
            { "p95", report.latency_p95 }, { "p99", report.latency_p99 },
            { "p999", report.latency_p999 } };
    }
    json_report["statusCodes"] = report.status_codes;

    if (target_rps > 0) {
        json_report["rateControl"] = { { "targetRps", report.target_rps },
            { "actualRps", report.actual_rps }, { "achievement", report.rps_achievement } };
        if (const auto& sending = extras.sending) {
            json_report["rateControl"]["requestsSent"] = sending->requests_sent;
            json_report["rateControl"]["requestsExpected"] = sending->requests_expected;
        }
    }

    nlohmann::json errors_obj;
    errors_obj["total"]       = report.failed_requests;
    errors_obj["withDetails"] = report.errors_with_details;
    errors_obj["types"]       = report.error_types;
    if (!report.errors_by_status_code.empty ()) {
        errors_obj["byStatusCode"] = report.errors_by_status_code;
    }
    json_report["errors"] = errors_obj;

    // Two halves under one key. With stored phase means, both describe every
    // successful completion (#2782); otherwise (the bank off, an older run) the
    // averages fall back to the trace sample and are absent with no traces, and
    // `phases` is absent for a run predating the bank. Clients read each half
    // by its key, never by the object's presence.
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

    // `count` is exact for a run stored after #2399 and `tracesStored` is the
    // sample the run kept. `percentage` divides by every completion, failed
    // ones included, though only a success can be slow.
    if (report.slow_threshold_ms > 0) {
        json_report["slowRequests"] = { { "count", report.slow_requests_count },
            { "thresholdMs", report.slow_threshold_ms },
            { "tracesStored", report.slow_traces_stored },
            { "percentage",
            report.total_requests > 0 ?
            (static_cast<double> (report.slow_requests_count) * 100.0 /
            static_cast<double> (report.total_requests)) :
            0.0 } };
    }

    // What each bounded store thinned away. All zeros: the sampled sets are
    // complete; otherwise a uniform reservoir sample of the run, not its
    // opening, except where `responseSampleBudgetSpent` says the byte budget
    // stopped admitting, leaving the tested set drawn from where bodies fit.
    // Covers the error, trace and response stores; `results` is a
    // failures-first selection that says so through `resultsStored` /
    // `resultsCap` (#2210).
    if (extras.has_sampling) {
        json_report["sampling"] = { { "errorsDropped", extras.errors_dropped },
            { "successTracesDropped", extras.success_traces_dropped },
            { "slowTracesDropped", extras.slow_traces_dropped },
            { "responseSamplesDropped", extras.response_samples_dropped },
            { "exemplarsDropped", extras.exemplars_dropped },
            { "sampleBodiesDropped", extras.sample_bodies_dropped },
            { "responseBodiesCaptured", extras.response_bodies_captured } };
        // Only when recorded: absent is a run predating the marker, which the
        // app must tell from one that kept its uniformity.
        if (extras.response_sample_budget_spent.has_value ()) {
            json_report["sampling"]["responseSampleBudgetSpent"] =
            *extras.response_sample_budget_spent;
        }
    }

    add_optional_report_sections (extras, json_report);
    return json_report;
}

/// Rows a non-scenario run's report `results` carries at most.
constexpr size_t REPORT_RESULTS_CAP = 100;

/// How many of @p stored rows the report returns. A `Scenario` run's rows are
/// the steps `ScenarioRunView` renders, bounded at write time by
/// `maxScenarioStoredSteps` (`scenario_runner.cpp`); a second cap here would
/// drop every step past the 100th from a run the same report says ran more.
size_t report_results_cap (size_t stored, bool is_scenario_run) {
    return is_scenario_run ? stored : REPORT_RESULTS_CAP;
}

/// The rows a capped report returns, in `timestamp` order (ties by row id).
///
/// Chosen by value, not position: a failing status (`!is_success_status`,
/// which includes the 0 of a transport failure) takes a slot first, and
/// healthy rows fill what is left in storage order. The first @p cap stored
/// rows are the run's opening, which on a long run holds none of the failures
/// a reader opened the report to find (#2210). Selection reads `status_code`
/// only - `trace_data` is parsed for the chosen rows alone.
std::vector<const vayu::db::Result*>
select_report_results (const std::vector<vayu::db::Result>& results, size_t cap) {
    std::vector<const vayu::db::Result*> chosen;
    chosen.reserve (std::min (results.size (), cap));
    for (const auto& result : results) {
        if (chosen.size () < cap && !vayu::is_success_status (result.status_code)) {
            chosen.push_back (&result);
        }
    }
    for (const auto& result : results) {
        if (chosen.size () >= cap) {
            break;
        }
        if (vayu::is_success_status (result.status_code)) {
            chosen.push_back (&result);
        }
    }
    std::ranges::sort (chosen, [] (const auto* a, const auto* b) {
        return std::tie (a->timestamp, a->id) < std::tie (b->timestamp, b->id);
    });
    return chosen;
}

/**
 * A load run's whole-run counters while it is not terminal (#2659), in place
 * of the rows it writes only as it finishes. Only the collector's atomic reads:
 * its percentile, phase, stream and custom-metric readers walk histograms the
 * event-loop workers are still writing and are exact only after the drain, so
 * `latency` and the phase averages stay out until the summary brings them;
 * the live view reads the run-so-far phases off the gate frame instead
 * (`MetricsCollector::put_gate_distributions`). A null @p context (a run no
 * manager holds) leaves every count at zero.
 */
void apply_live_counters (const vayu::core::RunContext* context,
double duration_s,
vayu::DetailedReport& report,
ReportExtras& extras) {
    extras.latency_measured = false;
    if (context == nullptr || !context->metrics_collector) {
        return;
    }
    const auto& collector          = *context->metrics_collector;
    report.total_requests          = collector.total_requests ();
    report.status_codes            = collector.status_code_distribution ();
    extras.status_codes_overridden = true;
    if (duration_s > 0) {
        report.avg_rps = static_cast<double> (report.total_requests) / duration_s;
        report.throughput = report.avg_rps;
        report.send_rate = static_cast<double> (context->requests_sent.load ()) / duration_s;
    }
    extras.cancelled_requests = collector.cancelled ();
    extras.peak_concurrency = static_cast<double> (context->peak_in_flight.load ());
    extras.avg_in_flight  = collector.average_in_flight (duration_s);
    extras.dropped_total  = static_cast<double> (collector.dropped_requests ());
    extras.skipped_total  = static_cast<double> (collector.skipped_requests ());
    extras.stalled_ms     = collector.stalled_ms ();
    extras.queue_wait_avg = collector.average_queue_wait ();
    extras.bytes_sent     = static_cast<double> (collector.total_bytes_sent ());
    extras.bytes_received = static_cast<double> (collector.total_bytes_received ());
    extras.http_version_downgraded =
    static_cast<double> (collector.http_version_downgraded ());
    extras.connection_replays = collector.connection_replays ();
    extras.error_classes      = collector.error_class_counts ().to_json ();
}

namespace {

/**
 * One stored result as the report's `results[]` carries it, and as
 * `GET /runs/:runId/results/:resultId` answers it. The trace is served as
 * stored, except that a design stream's `events` sidecar becomes the list its
 * stored body holds (`expand_stored_stream_events`, #3770); one that does not
 * parse travels as the raw string rather than failing the read.
 */
nlohmann::json report_result_node (const vayu::db::Result& result) {
    nlohmann::json node;
    node["id"]         = result.id;
    node["timestamp"]  = result.timestamp;
    node["statusCode"] = result.status_code;
    node["statusText"] = result.status_text;
    node["latencyMs"]  = result.latency_ms;
    if (!result.error.empty ()) {
        node["error"] = result.error;
    }
    if (!result.trace_data.empty ()) {
        try {
            node["trace"] = nlohmann::json::parse (result.trace_data);
            vayu::http::expand_stored_stream_events (node["trace"]);
        } catch (...) {
            node["trace"] = result.trace_data;
        }
    }
    return node;
}

} // namespace

/**
 * The run's own exchanges, for a design or load run - a design run has exactly
 * one and a load run's percentiles do not need per-request rows past a
 * representative few. Past @p cap rows the kept ones are the failures first,
 * not a uniform sample (see select_report_results). The row id travels so a
 * client can ask `GET /runs/:id/samples` for the captured bodies, which
 * deliberately do not ride this payload (see run_samples_response).
 */
nlohmann::json build_report_results (const std::vector<vayu::db::Result>& results, size_t cap) {
    nlohmann::json results_array = nlohmann::json::array ();
    for (const auto* row : select_report_results (results, cap)) {
        results_array.push_back (report_result_node (*row));
    }
    return results_array;
}

/**
 * Testable core of GET /runs/:id/report, {http_status, json_body}; a missing
 * run is a 404 in the shared `{"error": {"code", "message"}}` shape. The
 * whole-run aggregates come from `runs.summary`, computed by the run at
 * completion, laid over a report from its sampled `results`. A run with no
 * summary (pending, running, or failed without writing one) reports without one
 * rather than erroring, and one the engine died under carries its last tick's
 * totals as a partial summary (#2895); `summary.partial` and
 * `summary.summaryMissing` say which. Exceptions propagate to the route's
 * try/catch (500); `runs_route_report_test.cpp` covers the wiring.
 */
std::pair<int, nlohmann::json> run_report_response (vayu::db::Database& db,
const std::string& run_id,
vayu::core::RunManager* live_runs) {
    // Off the DB mutex (#2679): a live load run's report is polled while its
    // results flush, and this row is the poll's only read. The rows read below
    // come after it, on the main connection, so they are never older than the
    // status they are chosen by.
    auto run = db.get_run_snapshot (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }

    // A non-terminal load run reads no row (#2659): a client re-reads this
    // report until the run ends, and the run writes its rows as it finishes, so
    // they would read as zeros, then a growing prefix of the flush; its counts
    // come from the collector (`apply_live_counters`). Decided from the row
    // `metadata.status` reports. Design and scenario runs store their rows just
    // before the status flips, and their one-shot readers (response restore,
    // the step list) need them, `trace` included, from a report fetched in that
    // gap.
    const bool live_load =
    run->type == vayu::RunType::Load && !vayu::is_terminal (run->status);
    const auto results =
    live_load ? std::vector<vayu::db::Result>{} : db.get_results (run_id);

    double duration_s = 0;
    if (run->start_time > 0) {
        int64_t end = run->end_time > 0 ? run->end_time : now_ms ();
        duration_s  = static_cast<double> (end - run->start_time) / 1000.0;
    }

    auto report =
    vayu::utils::MetricsHelper::calculate_detailed_report (results, duration_s);

    // `summary` is written as the run finishes (#2436), so none usable means
    // the run is pending, running, or failed without one (`summary_missing`
    // below): the report stands on the sampled `results` or, for a live load
    // run, its collector, and `metadata.status` tells them apart. A live load
    // run's stored summary is the whole-run answer, as for a finished run.
    ReportExtras extras;
    extras.sequential_run = run->type == vayu::RunType::Scenario;
    if (live_load && run->summary.empty ()) {
        const auto context =
        live_runs != nullptr ? live_runs->get_run_or_retained (run_id) : nullptr;
        apply_live_counters (context.get (), duration_s, report, extras);
    }
    apply_run_summary (run->summary, report, extras);
    // A failed load run with no summary has no whole-run totals at all: the
    // engine died with no tick to rebuild them from (#2895), or the worker
    // failed on a path that writes none. Its sampled rows are not the run's
    // latency either, so the report carries none.
    extras.summary_missing = run->type == vayu::RunType::Load &&
    run->status == vayu::RunStatus::Failed && run->summary.empty ();
    if (extras.summary_partial || extras.summary_missing) {
        extras.latency_measured = false;
    }

    const double target_rps =
    reconcile_report_rates (run->config_snapshot, duration_s, extras, report);

    nlohmann::json json_report = build_report_body (report, extras, target_rps);
    json_report["metadata"]    = build_report_metadata (run_id, *run);
    const size_t results_cap = report_results_cap (results.size (), extras.sequential_run);
    json_report["results"]       = build_report_results (results, results_cap);
    json_report["resultsStored"] = results.size ();
    json_report["resultsCap"]    = results_cap;

    return { 200, json_report };
}

std::pair<int, nlohmann::json> run_result_response (vayu::db::Database& db,
const std::string& run_id,
std::string_view result_id) {
    if (!db.get_run (run_id)) {
        return { 404, error_body (404, "Run not found") };
    }
    // Past `int` is an id SQLite never assigned here, so it is as unknown as
    // any other.
    const auto id = vayu::utils::parse_number<int> (result_id);
    auto result   = id ? db.get_result (run_id, *id) : std::nullopt;
    if (!result) {
        return { 404, error_body (404, "Result not found") };
    }
    return { 200, report_result_node (*result) };
}

/**
 * The `GET /runs` filters off the query string. An invalid value for an
 * enumerated filter (`type`, `status`, `baseline`, `origin`, `outcome`) leaves
 * it unset, not a 400, so a client on a newer vocabulary gets a wider list.
 * Non-static for `runs_route_rows_test.cpp`.
 */
vayu::db::RunFilter run_filter_from_query (const httplib::Request& req) {
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
    if (req.has_param ("baseline")) {
        const std::string value = req.get_param_value ("baseline");
        if (value == "true")
            filter.baseline = true;
        else if (value == "false")
            filter.baseline = false;
    }
    if (req.has_param ("origin")) {
        std::string value = req.get_param_value ("origin");
        if (is_run_origin_kind (value))
            filter.origin = std::move (value);
    }
    if (req.has_param ("outcome"))
        filter.outcome =
        vayu::parse_run_outcome (req.get_param_value ("outcome"));
    return filter;
}

/**
 * Testable core of GET /runs/:id, {http_status, json_body}. A design run's one
 * exchange travels with the run; a load run's stay in the report (the sampled
 * subset), guarded before fetching because they are unbounded (one row per
 * error) and must never be pulled to be discarded.
 *
 * The snapshot's body is what a history entry re-opens into the editor, so its
 * file references carry the `unresolved` the allowed folders and picked files
 * derive now, never what was sent (#2356). A run @p live_runs holds active
 * carries its worker's `phase` (#3568); never stored, so a retained or stored
 * run, or a null @p live_runs, has none.
 */
std::pair<int, nlohmann::json> get_run_response (vayu::db::Database& db,
const std::string& run_id,
vayu::core::RunManager* live_runs) {
    const auto run = db.get_run (run_id);
    if (!run) {
        return { 404, error_body (404, "Run not found") };
    }
    vayu::utils::log_debug ("run", "Found run",
    { { "runId", run_id }, { "type", to_string (run->type) },
    { "status", to_string (run->status) } });
    auto payload = vayu::json::serialize (*run);
    if (run->type == vayu::RunType::Design) {
        vayu::json::attach_design_result (payload, *run, db.get_results (run_id));
    }
    const auto snapshot = payload.find ("configSnapshot");
    if (snapshot != payload.end () && snapshot->is_object () && snapshot->contains ("body")) {
        vayu::json::derive_file_trust (
        snapshot->at ("body"), vayu::http::FileAccessPolicy::from_database (db));
    }
    const auto context = live_runs != nullptr ? live_runs->get_run (run_id) : nullptr;
    if (context) {
        payload["phase"] = vayu::core::to_string (context->phase ());
    }
    return { 200, std::move (payload) };
}

namespace {

void handle_list_runs (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    // Parse + clamp pagination; the filters are run_filter_from_query's.
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

    std::optional<std::string> before;
    if (req.has_param ("before")) {
        before = req.get_param_value ("before");
    }

    try {
        auto [status, body] = get_runs_response (ctx.db,
        run_filter_from_query (req), limit, offset, ctx.run_summary_cache, before);
        res.status          = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "GET /runs - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_get_run (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    try {
        auto [status, body] = get_run_response (ctx.db, run_id, &ctx.run_manager);
        if (status == 404) {
            vayu::utils::log_warning ("run", "GET /runs/:id - Run not found: " + run_id);
        }
        res.status = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "GET /runs/:id - Error fetching run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_delete_run (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    try {
        auto [status, body] =
        delete_run_response (ctx.db, ctx.run_manager, run_id, DELETE_STOP_WAIT_MS);
        res.status = status;
        res.set_content (body.dump (), "application/json");
        if (status == 200) {
            vayu::utils::log_info (
            "run", "DELETE /runs/:id - Successfully deleted run: " + run_id);
        } else if (status == 404) {
            vayu::utils::log_warning ("run", "DELETE /runs/:id - Run not found: " + run_id);
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "DELETE /runs/:id - Error deleting run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_clear_runs (RouteContext& ctx, httplib::Response& res) {
    try {
        auto [status, body] = clear_runs_response (ctx.db);
        res.status          = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "DELETE /runs - Error clearing run history: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_set_baseline (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    try {
        auto [status, body] = set_run_baseline_response (ctx.db, run_id, req.body);
        res.status = status;
        // `replace`: a parse refusal quotes the bytes it stopped at (#2671).
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
        if (status == 404) {
            vayu::utils::log_warning (
            "run", "PUT /runs/:id/baseline - Run not found: " + run_id);
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "PUT /runs/:id/baseline - Error for run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

/// The message a settled stream's Stop answer carries for the status its worker
/// stored.
const char* stream_stop_message (vayu::RunStatus status) {
    switch (status) {
    case vayu::RunStatus::Stopped: return "Stream stopped";
    case vayu::RunStatus::Completed: return "The stream had already ended";
    case vayu::RunStatus::Failed:
        return "The stream failed before the stop took effect";
    // The completion callback threw before its write; the startup sweep
    // settles the row.
    case vayu::RunStatus::Pending:
    case vayu::RunStatus::Running:
        return "Stop signalled; the stream ended without storing its result";
    }
    return "Stop signalled";
}

/**
 * The answer to a Stop already signalled to @p stream (#3342): the run row's
 * stored status once the stream has closed, because the server or a cap can
 * end it before the transfer reads the flag. `closed ()` is released only after
 * the worker's completion callback has written the row, so the read after it
 * is the terminal one. A wait that runs out answers `running`: a row read then
 * may be mid-write.
 */
nlohmann::json stream_stop_response (vayu::db::Database& db,
const std::shared_ptr<vayu::http::SseStreamContext>& stream,
const std::string& run_id,
int grace_seconds) {
    // A transfer notices within one progress callback; `closed()` then waits
    // for the post-request script and the row write too (#3239), so a slow
    // script can outlast the grace.
    const auto deadline =
    std::chrono::steady_clock::now () + std::chrono::seconds (grace_seconds);
    while (stream && !stream->closed () && std::chrono::steady_clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }

    nlohmann::json response;
    response["runId"] = run_id;
    if (stream) {
        response["totalEvents"] = stream->total_events ();
    }
    // A null stream was swept, which only a closed one is.
    if (stream && !stream->closed ()) {
        response["status"]  = to_string (vayu::RunStatus::Running);
        response["message"] = grace_expired_message (grace_seconds);
        return response;
    }
    const auto run      = db.get_run (run_id);
    const auto status   = run ? run->status : vayu::RunStatus::Running;
    response["status"]  = to_string (status);
    response["message"] = stream_stop_message (status);
    return response;
}

void handle_stop_run (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    try {
        auto run = ctx.db.get_run (run_id);
        if (!run) {
            vayu::utils::log_warning ("run", "POST /runs/:id/stop - Run not found: " + run_id);
            send_error (res, 404, "Run not found");
            return;
        }

        if (vayu::is_terminal (run->status)) {
            vayu::utils::log_info ("run", "Run already finished",
            { { "runId", run_id }, { "status", to_string (run->status) } });
            auto response = vayu::utils::MetricsHelper::create_already_stopped_response (
            run_id, to_string (run->status));
            res.set_content (response.dump (), "application/json");
            return;
        }

        // A streaming design run stops by asking its consumer worker to end the
        // transfer (#573), checked before the load path because a design run
        // has no `RunContext`: the not-active branch would mark the row Stopped
        // while the worker still holds a socket. The worker owns the terminal
        // write (`record_design_result`, when it settles, with the trace and
        // the true event count), so the row is left alone here.
        if (ctx.sse_manager.request_stop (run_id)) {
            vayu::utils::log_info (
            "run", "POST /runs/:id/stop - Signaling stop for stream: " + run_id);
            // Awaited, not answered at once, so the caller hears what happened,
            // on the load path's graceful-stop budget.
            const auto response = stream_stop_response (
            ctx.db, ctx.sse_manager.get (run_id), run_id, STOP_GRACE_SECONDS);
            res.set_content (response.dump (), "application/json");
            return;
        }

        auto context = ctx.run_manager.get_run (run_id);
        if (context) {
            const auto response =
            stop_active_run_response (ctx.db, *context, run->type, STOP_GRACE_SECONDS);
            res.set_content (response.dump (), "application/json");
        } else {
            auto [status, body] =
            stop_unregistered_run_response (ctx.db, ctx.run_manager, run_id);
            res.status = status;
            res.set_content (body.dump (), "application/json");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "POST /runs/:id/stop - Error stopping run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

void handle_get_run_report (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info (
    "run", "GET /runs/:id/report - Generating report for run: " + run_id);
    try {
        auto [status, body] = run_report_response (ctx.db, run_id, &ctx.run_manager);
        if (status == 404) {
            vayu::utils::log_warning (
            "run", "GET /runs/:id/report - Run not found: " + run_id);
        }
        res.status = status;
        res.set_content (body.dump (2), "application/json");
    } catch (const std::exception& e) {
        send_error (res, 500, e.what ());
    }
}

void handle_get_run_result (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const std::string run_id    = req.matches[1];
    const std::string result_id = req.matches[2];
    try {
        auto [status, body] = run_result_response (ctx.db, run_id, result_id);
        res.status          = status;
        // `replace`: a trace that does not parse is served as its stored
        // text, which nothing held to UTF-8.
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "Reading a stored result failed",
        { { "runId", run_id }, { "resultId", result_id }, { "error", e.what () } });
        send_error (res, 500, e.what ());
    }
}

void handle_get_run_samples (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    std::string run_id = req.matches[1];
    vayu::utils::log_info ("run",
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
            "run", "GET /runs/:id/samples - Run not found: " + run_id);
        }
        res.status = status;
        // `replace`: a stream's events are parsed from the stored bytes, which
        // `bodyEncoding` does not cover and which need not be UTF-8 (#3159).
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "GET /runs/:id/samples - Error for run " + run_id + ": " + e.what ());
        send_error (res, 500, e.what ());
    }
}

} // namespace

void register_run_routes (RouteContext& ctx) {
    /**
     * GET /runs?limit=&offset=&before=&type=&status=&requestId=&collectionId=&q=
     *          &baseline=&origin=&outcome=
     * Lists runs newest first (start_time DESC, ties by id DESC). Rows carry the
     * compact `summary` (`build_run_summary` holds the key list) instead of the
     * full config_snapshot, in the `{data, pagination}` envelope, plus each run
     * type's `resultSummary` (`get_runs_response`).
     *
     * Query params:
     * - limit: page size, default 50, capped at 500
     * - offset: rows to skip, floored at 0
     * - before: keyset cursor "<startTime>:<id>", the previous page's
     *   pagination.nextBefore; the page starts after that row and costs about
     *   `limit` rows however deep it is. Malformed -> 400 invalid_before;
     *   beside a non-zero offset -> 400 before_with_offset. Filters still apply
     *   and `total` still counts the whole filter.
     * - type: "design" | "load" | "scenario"
     * - status: a RunStatus string
     * - requestId: exact match
     * - collectionId: exact match against a run's stored
     *   `scenario.collectionId`, which collection runs and load runs over a
     *   collection record (#3544); a single-request run never matches, and an
     *   id nothing ran is an empty page
     * - q: case-insensitive substring over the stored config_snapshot text
     * - baseline: "true" pinned baselines only, "false" unpinned only
     * - origin: exact match on the recorded origin kind (#1817)
     * - outcome: the stored verdict; a run with none never matches
     * An invalid type, status, baseline, origin or outcome is ignored
     * (`run_filter_from_query`).
     */
    ctx.server.Get ("/runs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_list_runs (ctx, req, res);
    });

    /**
     * GET /runs/:runId
     * Retrieves details for a specific test run by its ID.
     */
    ctx.server.Get (R"(/runs/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_get_run (ctx, req, res);
    });

    /**
     * DELETE /runs
     * Clears run history: every run except pinned baselines and runs still in
     * flight, answering {deleted, keptPinned, deletedIds}. See
     * clear_runs_response.
     */
    ctx.server.Delete ("/runs", [&ctx] (const httplib::Request&, httplib::Response& res) {
        handle_clear_runs (ctx, res);
    });

    /**
     * DELETE /runs/:runId
     * Deletes a specific test run and all associated metrics/results. An active
     * run is stopped first and only deleted once its worker has settled; see
     * delete_run_response.
     */
    ctx.server.Delete (R"(/runs/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_delete_run (ctx, req, res);
    });

    /**
     * PUT /runs/:runId/baseline  - body {"baseline": true|false}
     * Pins or unpins a run as a baseline: the known-good run later runs are
     * compared against, and the one run retention will not expire. Answers the
     * updated list row; 404 when no such run, 400 on a body that does not carry
     * a boolean `baseline`.
     */
    ctx.server.Put (R"(/runs/([^/]+)/baseline)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_set_baseline (ctx, req, res);
    });

    /**
     * POST /runs/:runId/stop
     * Stops a running load test, collection run or streaming send. See
     * stop_active_run_response for what an active run answers.
     */
    ctx.server.Post (R"(/runs/([^/]+)/stop)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_stop_run (ctx, req, res);
    });

    /**
     * GET /runs/:runId/report
     * Retrieves a detailed statistical report for a specific test run.
     */
    ctx.server.Get (R"(/runs/([^/]+)/report)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_get_run_report (ctx, req, res);
    });

    /**
     * GET /runs/:runId/results/:resultId
     * One stored result, in the shape of a report `results[]` entry, so a
     * reader holding the handle a buffered `POST /execute` answered (#3704)
     * reads its exchange without fetching the whole report. See
     * run_result_response.
     */
    ctx.server.Get (R"(/runs/([^/]+)/results/(\d+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_get_run_result (ctx, req, res);
    });

    /**
     * GET /runs/:runId/samples?limit=&offset= The captured response headers and
     * bodies of the run's retained samples: every error, the slow outliers, the
     * first few of each status code. Its own endpoint because the report parses
     * every result row per fetch and the dashboard polls it; this is fetched
     * only when a reader expands a sample.
     */
    ctx.server.Get (R"(/runs/([^/]+)/samples)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_get_run_samples (ctx, req, res);
    });
}

} // namespace vayu::http::routes
