/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/load_strategy.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <format>
#include <functional>
#include <iostream>
#include <limits>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "vayu/core/load_pacing.hpp"
#include "vayu/core/path_template.hpp"
#include "vayu/core/refill_deficit.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
/// Stamp the executor's per-completion facts onto the record being built. One
/// helper for all three branches, so a record kind cannot quietly lose them.
void annotate (nlohmann::json& record, const ResultAnnotations& annotations) {
    if (annotations.data_row_index) {
        record["dataRowIndex"] = *annotations.data_row_index;
    }
}

/// Names a failed `mcp` reply's class, code and message on the record (#3762),
/// whichever store keeps it; a reply that succeeded adds nothing.
void stamp_mcp_failure (nlohmann::json& record, const vayu::Response& response) {
    if (const auto& reply = response.mcp_reply; reply && reply->error_class) {
        record["mcp"] = vayu::json::serialize_mcp_reply (*reply);
    }
}

} // namespace

namespace {

/**
 * @p response recorded as a failure under @p code and @p message: a transfer's
 * own error, or an `mcp` reply's failure class (#3762), whose record also
 * names the class and the JSON-RPC code.
 */
void record_failure (const std::shared_ptr<RunContext>& context,
const vayu::Response& response,
vayu::ErrorCode code,
const std::string& message,
const ResultAnnotations& annotations) {
    nlohmann::json error_json = { { "error_code", static_cast<int> (code) },
        { "error_type", vayu::error_type_name (code) }, { "message", message },
        { "request_number", context->total_requests () } };
    stamp_mcp_failure (error_json, response);

    annotate (error_json, annotations);

    if (response.timing.total_ms > 0) {
        error_json["timing"] = { { "totalMs", response.timing.total_ms },
            { "wireMs", response.timing.wire_ms },
            { "queueWaitMs", response.timing.queue_wait_ms },
            { "dnsMs", response.timing.dns_ms }, { "connectMs", response.timing.connect_ms },
            { "tlsMs", response.timing.tls_ms },
            { "firstByteMs", response.timing.first_byte_ms },
            { "downloadMs", response.timing.download_ms } };
    }

    // Every error is a capture candidate: a failure is the sample a user opens
    // the Samples tab for, and errors are already bounded by `maxStoredErrors`.
    // The response is passed, not copied, so body-sized work happens inside the
    // collector after it decides to keep the record
    // (`MetricsCollector::record_error`).
    //
    // A failure whose transfer ran joins the latency population at its own
    // duration (#2384): a timeout is the slowest outcome a request can have,
    // and percentiles without it describe only the requests that answered.
    std::optional<AttemptDuration> attempt;
    if (response.transfer_attempted) {
        attempt = AttemptDuration{ response.timing.total_ms + annotations.script_ms,
            response.timing.queue_wait_ms };
    }
    context->metrics_collector->record_error (code, message, error_json.dump (),
    context->capture_response_bodies ? &response : nullptr, attempt);
    context->metrics_collector->record_bytes (
    response.timing.bytes_up, response.timing.bytes_down);
}

} // namespace

/** A response that reached this engine carrying a client-side error. */
void record_failed_response (const std::shared_ptr<RunContext>& context,
const vayu::Response& response,
const ResultAnnotations& annotations) {
    record_failure (context, response, response.error_code, response.error_message, annotations);
}

/** A response that completed, and everything the run keeps of it. */
void record_successful_response (const std::shared_ptr<RunContext>& context,
const vayu::Response& response,
const ResultAnnotations& annotations) {
    // The trace and the slow threshold judge the transfer alone; the latency
    // population also carries the pipeline time `includeScriptTime` folds.
    const double transfer_ms = response.timing.total_ms;
    const double latency     = transfer_ms + annotations.script_ms;

    // Two independent reasons to keep a trace, both decided before anything is
    // serialised: the 1-in-N sampler (which advances its period on every
    // completion, so this call is not optional) and the slow threshold.
    // Building first and sampling after would construct and dump 99 of every
    // 100 traces inline in the completion drain only to discard them, delaying
    // socket processing for every other transfer on the worker.
    const bool is_slow = context->slow_threshold_ms > 0 &&
    transfer_ms >= static_cast<double> (context->slow_threshold_ms);
    const bool sampled = context->metrics_collector->should_sample_success ();
    // A third reason, the cheapest: one relaxed fetch_add deciding whether this
    // completion is among the first few of its status code. A uniform slice of
    // a 30M-request run is a thousand identical 200s; three of each code
    // answers "what does this target's 503 look like".
    const bool exemplar =
    context->metrics_collector->claim_status_exemplar (response.status_code);

    std::string trace_data;
    auto trace_reason = SuccessTraceReason::None;

    if (sampled || is_slow || exemplar) {
        // Slow wins, then sampled: the trace is identical either way, and
        // charging an outlier to the slow budget leaves the 1-in-N budget for
        // ordinary traffic.
        //
        // Exemplar is last and only picks the store for a completion no other
        // budget wanted. Ranked first it would steal outliers from the slow
        // store (the first completions of a status code are usually where a
        // run's outliers are), the store holding what the user asked for.
        // Retention is guaranteed either way: whichever budget claims it, the
        // record is stored, and the exemplar's real job, capturing a body, is
        // decided below.
        if (is_slow) {
            trace_reason = SuccessTraceReason::Slow;
        } else if (sampled) {
            trace_reason = SuccessTraceReason::Sampled;
        } else {
            trace_reason = SuccessTraceReason::Exemplar;
        }

        nlohmann::json timing_json = { { "totalMs", response.timing.total_ms },
            { "wireMs", response.timing.wire_ms },
            { "queueWaitMs", response.timing.queue_wait_ms },
            { "dnsMs", response.timing.dns_ms }, { "connectMs", response.timing.connect_ms },
            { "tlsMs", response.timing.tls_ms },
            { "firstByteMs", response.timing.first_byte_ms },
            { "downloadMs", response.timing.download_ms } };

        if (is_slow) {
            timing_json["isSlow"]      = true;
            timing_json["thresholdMs"] = context->slow_threshold_ms;
        }
        // A failed reply reaches this branch only under a status the
        // distribution already counts as a failure; the trace kept for it
        // names the cause, so nothing is counted twice.
        stamp_mcp_failure (timing_json, response);
        annotate (timing_json, annotations);

        trace_data = timing_json.dump ();
    }

    // Capture is decided here, not by which store won: an outlier or a claimed
    // exemplar gets a body, a plain 1-in-N sample does not (a thousand
    // identical 200s are not worth a thousand bodies). A completion both
    // sampled and an exemplar is stored in the sampled budget and keeps its
    // body.
    const bool capture_body = context->capture_response_bodies && (is_slow || exemplar);
    // The phase breakdown goes in whatever the gate above decided: `trace_data`
    // carries the same five numbers for the ~1% of completions something
    // retains, and the histograms carry the other 99% to the report.
    context->metrics_collector->record_success (response.status_code, latency,
    response.timing.queue_wait_ms, trace_data, trace_reason,
    capture_body ? &response : nullptr, &response.timing);
    context->metrics_collector->record_bytes (
    response.timing.bytes_up, response.timing.bytes_down);

    // Sampled for the deferred validation passes. What reads a scenario sample
    // (a step's script, a step's contract) is keyed to the step, so it goes to
    // that step's reservoir, and the collector refuses steps nothing reads; a
    // single-request run keeps one run-level store. Who sent it travels with
    // the sample either way, so the deferred script reads its bound row as
    // `pm.iterationData` (#993) and its iteration and user through `pm.info`
    // (#994), whichever reservoir kept it.
    const SampleIdentity identity{ annotations.iteration, annotations.vu,
        annotations.data_row_index };
    if (annotations.step_index) {
        context->metrics_collector->record_step_response_sample (
        response, *annotations.step_index, identity);
    } else if (!context->test_scripts.empty ()) {
        context->metrics_collector->record_response_sample (response, identity);
    }
}

namespace {
/**
 * A transfer that ended in an Error rather than a Response, as a failure. No
 * Error carries a transfer's timing, so none joins the latency population.
 */
void record_error_result (const std::shared_ptr<RunContext>& context,
const vayu::Error& error,
const ResultAnnotations& annotations) {
    nlohmann::json error_json = { { "error_code", static_cast<int> (error.code) },
        { "error_type", vayu::error_type_name (error.code) }, { "message", error.message },
        { "request_number", context->total_requests () } };
    annotate (error_json, annotations);
    context->metrics_collector->record_error (
    error.code, error.message, error_json.dump ());
}
} // namespace

bool is_stop_cancellation (const RunContext& context, const vayu::Error& error) {
    return error.code == vayu::ErrorCode::Cancelled && context.stop_was_requested ();
}

void handle_result (const std::shared_ptr<RunContext>& context,
vayu::db::Database& /* db - unused, kept for API compat */,
const vayu::Result<vayu::Response>& result,
const ResultAnnotations& annotations) {
    // A transfer usually completes as a Response carrying error_code, but a few
    // paths produce a real Error: curl-handle creation failure, a data-binding
    // failure and the event loop's cancellation. Dropping one would leave
    // requests_sent counted with no completion, inflating in_flight() and
    // shrinking effective concurrency for the rest of the run, which is why a
    // Stop's cancellation is recorded too, just not as an error.
    if (result.is_error ()) {
        const auto& error = result.error ();
        if (is_stop_cancellation (*context, error)) {
            context->metrics_collector->record_cancelled ();
        } else {
            record_error_result (context, error, annotations);
        }

        if (context->closed_loop.load (std::memory_order_relaxed)) {
            context->notify_refill ();
        }
        return;
    }

    // Bound once: past the early return the result holds a Response, and every
    // branch reads the same object.
    const auto& response = result.value ();

    // Counted before the success/error split: a transfer that connected,
    // negotiated HTTP/1.1 against an explicit `http2` and then failed still
    // tells the truth about the protocol under test. Read off the Response, so
    // `http_version_downgraded` stays the one definition
    // (`curl_version_map.hpp`).
    if (response.http_version_downgraded) {
        context->metrics_collector->record_http_version_downgrade ();
    }
    // Before the split too: a replay that then failed still reached the
    // target twice (#2799). Both run shapes complete through here.
    if (response.connection_replays > 0) {
        context->metrics_collector->record_connection_replays (
        static_cast<size_t> (response.connection_replays));
    }
    // Before the split too: a failed last hop still dropped what the hops
    // before it set.
    if (response.set_cookie_headers_dropped > 0) {
        context->metrics_collector->record_set_cookie_headers_dropped (
        response.set_cookie_headers_dropped);
    }

    // Counted before the split, as the downgrade is: a stream the target killed
    // after 30 events delivered 30 events, and throughput from only the streams
    // that ended cleanly would read highest on the runs that failed most. Only
    // a transfer that streamed carries the count (`Response::stream_events`
    // says why it is optional, not zero).
    if (const auto completion = stream_completion_of (response)) {
        context->metrics_collector->record_stream_completion (*completion);
    }
    // Before the split too (#3828): a failed `mcp` reply is counted by class
    // whichever branch records it, a transfer error or a 4xx/5xx included.
    if (const auto& reply = response.mcp_reply) {
        if (const auto& error_class = reply->error_class) {
            context->metrics_collector->record_mcp_failure (*error_class, reply->code);
        }
    }

    if (response.has_error ()) {
        record_failed_response (context, response, annotations);
    } else if (const auto* mcp = vayu::http::mcp_failure_behind_success_status (response)) {
        // A JSON-RPC error or a tool's `isError` under a 200 is an error of the
        // run, counted under its class; a 4xx or 5xx is one by its status.
        record_failure (context, response,
        vayu::mcp_error_code (vayu::utils::invariant_value (mcp->error_class,
        "mcp_failure_behind_success_status answers a failed reply")),
        mcp->message, annotations);
    } else {
        record_successful_response (context, response, annotations);
    }

    // Wake the closed-loop controller (no-op/near-free for open-loop modes).
    if (context->closed_loop.load (std::memory_order_relaxed)) {
        context->notify_refill ();
    }
}

// Declared in load_strategy.hpp, which says why every executor uses this one
// parser. A JSON number is seconds, as the MCP duration cap reads the field.
int64_t duration_field_ms (const nlohmann::json& config, const std::string& key, int64_t default_ms) {
    auto it = config.find (key);
    if (it == config.end () || it->is_null ())
        return default_ms;

    const auto parsed = duration_value_ms (*it);
    if (!parsed) {
        throw std::invalid_argument ("Invalid " + key + " " + it->dump () +
        ": expected a non-negative number with an optional ms/s/m/h unit "
        "(e.g. \"500ms\", \"30s\", \"5m\", \"2h\")");
    }
    return *parsed;
}

std::optional<int64_t> duration_value_ms (const nlohmann::json& value) {
    if (value.is_string ()) {
        return parse_duration_ms (value.get<std::string> ());
    }
    if (value.is_number ()) {
        const double seconds = value.get<double> ();
        if (std::isfinite (seconds) && seconds >= 0.0)
            return static_cast<int64_t> (seconds * 1000.0);
    }
    return std::nullopt;
}

double requested_rps (const nlohmann::json& config) {
    const auto rate = [&config] (const char* key) {
        const auto it = config.find (key);
        return it == config.end () || it->is_null () ? 0.0 : it->get<double> ();
    };
    const double rps = rate ("rps");
    return rps != 0.0 ? rps : rate ("targetRps");
}

bool is_constant_rps_mode (const nlohmann::json& config) {
    const auto mode = config.find ("mode");
    return mode == config.end () || mode->is_null () || *mode == "constant_rps";
}

double open_loop_rate (const nlohmann::json& config) {
    return is_constant_rps_mode (config) ? requested_rps (config) : 0.0;
}

namespace {

/// A non-negative JSON integer - the shape every `{fixedMs}` / `{minMs,
/// maxMs}` field must have.
bool is_non_negative_integer (const nlohmann::json& value) {
    return value.is_number_integer () && value.get<int64_t> () >= 0;
}

/// "asConfigured" | "off" | {fixedMs} | {minMs,maxMs} (#1498): every `timer.*`
/// element as configured, silenced, or replaced by one fixed or uniformly
/// random span for the run. A plain loop: `std::all_of` with a generic lambda
/// needs a `.template get<...>` disambiguator here.
bool is_valid_elements_timers_shape (const nlohmann::json& timers) {
    if (timers.is_string ()) {
        return timers == "asConfigured" || timers == "off";
    }
    if (!timers.is_object ()) {
        return false;
    }
    if (timers.contains ("fixedMs")) {
        return timers.size () == 1 && is_non_negative_integer (timers["fixedMs"]);
    }
    if (!timers.contains ("minMs") && !timers.contains ("maxMs")) {
        return false;
    }
    for (const auto& [key, value] : timers.items ()) {
        if ((key != "minMs" && key != "maxMs") || !is_non_negative_integer (value)) {
            return false;
        }
    }
    return true;
}

} // namespace

std::optional<std::string> validate_elements_run_override (const nlohmann::json& config) {
    const auto elements = config.find ("elements");
    if (elements == config.end () || elements->is_null ()) {
        return std::nullopt;
    }
    if (!elements->is_object ()) {
        return "The run's Timers/Scripts overrides ('elements') must be an "
               "object";
    }

    static const std::unordered_set<std::string> known_keys = { "timers",
        "scripts", "includeScriptTime", "seed" };
    for (const auto& [key, value] : elements->items ()) {
        (void)value;
        if (!known_keys.contains (key)) {
            return "'elements." + key +
            "' is not a recognized override - expected one of timers, "
            "scripts, includeScriptTime or seed";
        }
    }

    // "Timers" / "Scripts" are the labels `RunCollectionDialog` and
    // `LoadTestConfigDialog` show; `seed` and `includeScriptTime` have no
    // dialog control (API/MCP only), so they are named in plain English.
    if (auto timers = elements->find ("timers");
    timers != elements->end () && !is_valid_elements_timers_shape (*timers)) {
        return "The Timers override must be 'asConfigured', 'off', "
               "{\"fixedMs\": N} or {\"minMs\"/\"maxMs\": N}";
    }
    if (auto seed = elements->find ("seed");
    seed != elements->end () && !is_non_negative_integer (*seed)) {
        return "The run's random seed override must be a non-negative integer";
    }
    if (auto scripts = elements->find ("scripts"); scripts != elements->end ()) {
        if (!scripts->is_string () ||
        (*scripts != "asMarked" && *scripts != "allInline" && *scripts != "allDeferred")) {
            return "The Scripts override must be 'asMarked', 'allInline' or "
                   "'allDeferred'";
        }
    }
    if (auto include_time = elements->find ("includeScriptTime");
    include_time != elements->end () && !include_time->is_boolean ()) {
        return "The run's 'include script time' override must be true or false";
    }

    return std::nullopt;
}

std::optional<std::string> validate_lifecycle_elements_run_override (
const nlohmann::json& config) {
    const auto lifecycle = config.find ("lifecycleElements");
    if (lifecycle == config.end () || lifecycle->is_null ()) {
        return std::nullopt;
    }
    if (auto scenario = config.find ("scenario");
    scenario != config.end () && !scenario->is_null ()) {
        return "'lifecycleElements' is only valid for a single-request run - "
               "a scenario collection declares script.setup/script.teardown "
               "on its own elements list instead";
    }
    if (!lifecycle->is_array ()) {
        return "'lifecycleElements' must be an array";
    }

    static const std::unordered_set<std::string> allowed_kinds = {
        "script.setup", "script.teardown"
    };
    for (size_t i = 0; i < lifecycle->size (); ++i) {
        const auto& entry = (*lifecycle)[i];
        // A malformed entry (not an object, no string "kind") is left for
        // `Registry::validate` below to report precisely, not folded into this
        // refusal as an empty kind.
        if (!entry.is_object () || !entry.contains ("kind") || !entry["kind"].is_string ()) {
            continue;
        }
        const std::string kind_name = entry["kind"].get<std::string> ();
        if (!allowed_kinds.contains (kind_name)) {
            const auto* kind = vayu::core::Registry::instance ().find (kind_name);
            return std::format (
            "Step {}: '{}' can only be a Setup script or Teardown script here",
            i + 1, kind != nullptr ? kind->label : kind_name);
        }
    }

    // Validated on a stamped copy, never `*lifecycle` itself:
    // `Registry::validate` refuses an id-less entry, and this array gets the
    // "engine assigns one when the caller sends none" default every `elements`
    // write path gives (`apply_elements_field`, `routes.hpp`), so a client
    // naming no id is not told to invent one.
    nlohmann::json stamped = *lifecycle;
    vayu::core::stamp_default_element_ids (stamped);
    return vayu::core::Registry::instance ().validate (
    stamped, vayu::core::ElementOwner::Collection);
}

namespace {

/**
 * The kinds `run_request_elements_step_before` / `_after_submission` can run
 * (#1594's scope: `extract.*`, `assert.*`, `timer.think`, `script.pre` /
 * `script.post`, the phase-0 set #1514 gave the design send). Every other kind
 * `Registry::validate` accepts under `ElementOwner::Request` needs state this
 * run shape never binds: `control.*` needs `controller_state` /
 * `SharedThroughputCounters` (a plan-wide scan a lone request never builds),
 * and `timer.pacing` / `timer.throughput` need `pacing_state` and the load
 * path's `scheduled_ready_delay_ms` dispatch
 * (`ScenarioLoadDriver::finish_step`'s job, with no single-request
 * counterpart).
 *
 * Accepting one would not fail loudly: `apply` would get a null
 * `controller_state`, most kinds would no-op or run unconditionally past a null
 * check, and `summary["elements"]` would report `"ok"` for behaviour that never
 * happened (`control.once` running on every submission is the sharpest case).
 * Refusing the kind by name is the "written and read by nothing" guard;
 * widening the set is deliberate follow-up work.
 */
constexpr std::array<std::string_view, 12> REQUEST_ELEMENTS_SUPPORTED_KINDS{
    "extract.json",
    "extract.header",
    "extract.regex",
    "extract.boundary",
    "assert.status",
    "assert.jsonpath",
    "assert.jsonschema",
    "assert.snapshot",
    "assert.contains",
    "assert.duration",
    "assert.size",
    "timer.think",
    // script.pre / script.post checked separately below - HotPathClass::Script,
    // not a literal comparison, per the extensibility contract's rule 1.
};

/// A string member of an optional JSON object, or empty when the member is
/// absent or not a string - `origin` is client-stamped and is not trusted to
/// carry either.
std::string string_member (const nlohmann::json& object, const char* key) {
    const auto found = object.find (key);
    if (found == object.end () || !found->is_string ()) {
        return {};
    }
    return found->get<std::string> ();
}

/// Where a refused element was declared, from the `origin` composition stamps
/// (`emit_level`, `request_composer.cpp`): a collection by name, the request,
/// or, for an entry written straight into the payload with no origin, its id. A
/// folder reads as "collection": the message reaches the user, who has no
/// folder (`docs/ux-writing.md`).
std::string element_whereabouts (const nlohmann::json& entry) {
    const auto origin = entry.find ("origin");
    if (origin != entry.end () && origin->is_object ()) {
        std::string scope = string_member (*origin, "scope");
        if (scope.empty ()) {
            scope = string_member (*origin, "kind");
        }
        const std::string name = string_member (*origin, "name");
        if (scope == "request") {
            return "set on this request";
        }
        if (!scope.empty () && !name.empty ()) {
            return std::format ("from the collection '{}'", name);
        }
        if (!scope.empty ()) {
            return "from a collection";
        }
    }
    return std::format ("element '{}'", entry.value ("id", ""));
}

/// The refusal for an entry whose kind has no home on a single-request run, or
/// nullopt when supported or switched off. A disabled element is skipped before
/// its `apply` runs (`compile_elements`), so a composed chain carrying one is
/// no reason to refuse the run (#3050). The entry is named by label and origin,
/// not position: a composed list interleaves inherited elements with the
/// request's own, so an index points at nothing the user sees.
std::optional<std::string> refuse_scenario_only_element (const nlohmann::json& entry) {
    if (!entry.value ("enabled", true)) {
        return std::nullopt;
    }
    const std::string kind_name = entry.value ("kind", "");
    const auto* kind = vayu::core::Registry::instance ().find (kind_name);
    const bool is_script =
    kind != nullptr && kind->hot_path == vayu::core::HotPathClass::Script;
    const bool is_supported = is_script ||
    std::find (REQUEST_ELEMENTS_SUPPORTED_KINDS.begin (),
    REQUEST_ELEMENTS_SUPPORTED_KINDS.end (),
    kind_name) != REQUEST_ELEMENTS_SUPPORTED_KINDS.end ();
    if (is_supported) {
        return std::nullopt;
    }
    return std::format (
    "'{}' ({}) can only be used in a scenario, not a single-request load "
    "test. Remove it, or run this as a scenario instead",
    kind != nullptr ? kind->label : kind_name, element_whereabouts (entry));
}

/// `element_level` of a raw entry as a hashable key. An entry with no
/// `origin` (written straight into the payload) has the empty level, as it
/// does in the run's tallies.
std::string level_key (const nlohmann::json& entry) {
    vayu::core::ElementLevel level;
    if (entry.is_object ()) {
        if (const auto origin = entry.find ("origin"); origin != entry.end ()) {
            level = vayu::core::element_level (*origin);
        }
    }
    return std::format ("{}/{}/{}", level.kind, level.scope, level.id);
}

/// @p elements split into one array per level, in first-appearance order. An id
/// is unique only within its declaring level's list, and a duplicated
/// collection or a folder repeated down a chain repeats ids across levels, so
/// uniqueness cannot be judged over the merged list (#3101;
/// `validate_execute_elements` does the same for `POST /execute`).
std::vector<nlohmann::json> split_by_level (const nlohmann::json& elements) {
    std::vector<nlohmann::json> levels;
    std::unordered_map<std::string, size_t> position;
    for (const auto& entry : elements) {
        const auto [slot, inserted] =
        position.try_emplace (level_key (entry), levels.size ());
        if (inserted) {
            levels.push_back (nlohmann::json::array ());
        }
        levels.at (slot->second).push_back (entry);
    }
    return levels;
}

} // namespace

std::optional<std::string> validate_request_elements_run_override (
const nlohmann::json& config) {
    const auto elements = config.find ("requestElements");
    if (elements == config.end () || elements->is_null ()) {
        return std::nullopt;
    }
    if (auto scenario = config.find ("scenario");
    scenario != config.end () && !scenario->is_null ()) {
        return "'requestElements' is only valid for a single-request run - a "
               "scenario collection's steps already carry their own resolved "
               "elements";
    }
    if (!elements->is_array ()) {
        return "'requestElements' must be an array";
    }

    // Stamped as `validate_lifecycle_elements_run_override` stamps its array,
    // so a caller naming no id gets one.
    nlohmann::json stamped = *elements;
    vayu::core::stamp_default_element_ids (stamped);
    // Every entry, disabled ones included, so a bad config fails here, not when
    // it is switched on. Each level is judged as a request's own list, so a
    // collection-only kind (`script.setup`) stays refused; the renderer filters
    // those out before sending (#3070).
    for (const auto& level : split_by_level (stamped)) {
        if (auto reason = vayu::core::Registry::instance ().validate (
            level, vayu::core::ElementOwner::Request)) {
            return reason;
        }
    }
    for (const auto& entry : stamped) {
        if (auto refusal = refuse_scenario_only_element (entry)) {
            return refusal;
        }
    }
    return std::nullopt;
}

bool declares_request_elements (const nlohmann::json& config) {
    const auto elements = config.find ("requestElements");
    return elements != config.end () && elements->is_array () && !elements->empty ();
}

std::optional<std::string> plan_load_files (vayu::http::FilePlan& files,
vayu::Request& request,
const LoadDataSet* data) {
    if (data == nullptr) {
        return plan_request_files (files, request, {}, nullptr);
    }
    const StepDataTemplate fields = tokenize_bindable_fields (request, data->bound_columns);
    return plan_request_files (
    files, request, data->rows, [&] (vayu::Request& bound, size_t row) {
        const IterationBinding binding{ &data->rows.at (row), row,
            IterationIdentity{ SOLE_VIRTUAL_USER, 0 } };
        return apply_iteration_template (bound, fields, binding);
    });
}

namespace {

// Raises the in-flight high-water mark. A CAS-max because the 1 Hz metrics
// sample in run_manager.cpp writes the same atomic.
inline void update_peak (const std::shared_ptr<RunContext>& context) {
    size_t f    = context->in_flight ();
    size_t prev = context->peak_in_flight.load (std::memory_order_relaxed);
    while (f > prev &&
    !context->peak_in_flight.compare_exchange_weak (prev, f, std::memory_order_relaxed)) {
        // prev reloaded on failure
    }
}

// The request every submission copies, plus the credential swap that keeps it
// current. The strategy owns it: its thread is the event loop's sole producer
// and `EventLoop::submit` copies the request at submit time, so a value written
// here reaches every later transfer and none already queued, with no lock on
// the submission path.
//
// A single-request run has at most one credential to keep current. A run
// without mid-run refresh (the common case, see plan_auth_refresh) never enters
// the swap: `current()` short-circuits on a null state.
/**
 * Whether every submission of this run sends the shared request as it stands:
 * nothing to bind (@p bind_template is the run's split), no credential to
 * apply, no `step.before` kind to write into it - so no per-submission copy,
 * and no residual pass either.
 */
bool sends_the_shared_request (const RunContext& context, const StepDataTemplate& bind_template) {
    return context.load_data == nullptr && bind_template.empty () &&
    context.load_auth.auth_resolution () == vayu::http::AuthResolution::Apply &&
    !context.step_elements_have_step_before;
}

bool sends_the_shared_request (const RunContext& context) {
    return sends_the_shared_request (context, context.load_template);
}

/**
 * What a run sending the shared request does to it once, before the first
 * submission. A path value composition left waiting (#1764) is answered by a
 * bind or the residual pass, and such a run runs neither, so it is written now,
 * as the residual pass would.
 */
void settle_shared_request (vayu::Request& request) {
    settle_path_variables (request, PathSettle::All);
    // Once here rather than in every transfer's `wire_url` and DNS-cache pin,
    // which then take their ASCII fast path. A host with no ASCII name stays
    // as typed for `validate_transferable` to refuse.
    (void)vayu::http::to_ascii_host (request.url);
}

class SubmissionRequest {
    public:
    SubmissionRequest (const std::shared_ptr<RunContext>& context, vayu::Request request)
    : state_ (context->auth_refresh_states.empty () ?
      nullptr :
      context->auth_refresh_states.front ()),
      request_ (std::move (request)) {
        if (sends_the_shared_request (*context)) {
            settle_shared_request (request_);
        }
    }

    const vayu::Request& current () {
        sync_auth_header (state_, request_, seen_generation_);
        return request_;
    }

    /**
     * This submission's 0-based index, claimed off the run-wide cursor: the
     * run's iteration (what `{{$iteration}}` binds and a retained record
     * reports to the deferred script, #994) and, modulo the row count, its data
     * row, always wrapping (#993). One counter, so the iteration a script reads
     * and the row it was sent with cannot disagree. No atomic or lock: the
     * strategy thread is the event loop's sole producer.
     */
    size_t claim_submission () {
        return cursor_++;
    }

    private:
    std::shared_ptr<AuthRefreshState> state_;
    vayu::Request request_;
    uint64_t seen_generation_ = 0;
    size_t cursor_            = 0;
};

/// The data row @p annotations claimed, or null for a run with no data set. It
/// points into the run's own set, which outlives every submission of the run.
const nlohmann::json* submission_row (const RunContext& context,
const ResultAnnotations& annotations) {
    const LoadDataSet* data = context.load_data.get ();
    if (data == nullptr || !annotations.data_row_index) {
        return nullptr;
    }
    return &data->rows.at (*annotations.data_row_index);
}

/// This submission's request, iteration, virtual user and row, for `pm.info`
/// and `pm.iterationData` inside an inline script (#3124, #3460) - what the
/// deferred replay binds off the stored record (`run_manager.cpp`), read here
/// off the live submission. `iteration_count` stays unset, as it does there.
void bind_submission_identity (vayu::runtime::ScriptContext& script_ctx,
const RunContext& context,
const ResultAnnotations& annotations) {
    script_ctx.request_id     = context.script_request_id;
    script_ctx.request_name   = context.script_request_name;
    script_ctx.iteration      = annotations.iteration;
    script_ctx.vu             = annotations.vu;
    script_ctx.iteration_data = submission_row (context, annotations);
}

/**
 * Runs @p context's `requestElements` `step.before` elements against
 * @p request, in place, writing into @p overlay: a fresh overlay for this
 * submission alone (#1594), never shared or kept across submissions as a
 * scenario run's per-VU overlay is, since many submissions run concurrently
 * with nothing to serialise them.
 */
void run_request_elements_step_before (const std::shared_ptr<RunContext>& context,
vayu::Request& request,
vayu::http::routes::ScopeOverlay& overlay,
const ResultAnnotations& annotations) {
    const nlohmann::json* row = submission_row (*context, annotations);
    std::vector<vayu::core::ElementOutcome> outcomes;
    vayu::ScriptResult pre_result;
    vayu::ScriptResult unused_post_result;
    vayu::core::ElementContext ctx{
        .request  = request,
        .response = nullptr,
        .run_pre_script =
        [&] (const std::string& script) {
            auto& engine = vayu::http::routes::script_engine_for_this_thread (
            context->step_script_config);
            auto scopes = overlay.materialize (context->lifecycle_scopes);
            auto script_ctx = vayu::runtime::ScriptContext::for_prerequest (request);
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            context->script_send.apply (script_ctx);
            bind_submission_identity (script_ctx, *context, annotations);
            script_ctx.record_metric = [context] (const std::string& name,
                                       vayu::core::CustomMetricType type, double value) {
                context->metrics_collector->record_custom_metric (name, type, value);
            };
            auto result = vayu::http::routes::execute_script (
            engine, script, script_ctx, "Pre-request");
            overlay.replace_from (scopes, context->lifecycle_scopes);
            return result;
        },
        .run_post_script    = nullptr,
        .pre_script_result  = pre_result,
        .post_script_result = unused_post_result,
        .set_variable =
        [&] (std::string_view scope, const std::string& name, const std::string& value) {
            overlay.set (scope, name, value, context->lifecycle_scopes);
        },
        .unset_variable =
        [&] (std::string_view scope, const std::string& name) {
            return overlay.unset (scope, name, context->lifecycle_scopes);
        },
        .should_stop = nullptr,
        // The submission's row under `data.*`, its local scope above the row
        // (#2564), as `scenario_load.cpp` resolves a step's (#3790).
        .resolve_template =
        [&] (const std::string& text) {
            vayu::http::VariableValues vars = context->step_base_vars;
            overlay.apply_onto (vars, context->lifecycle_scopes);
            return vayu::http::resolve_template_with_optional_row (
            text, vars, row, overlay.local_values ());
        },
        .blocking_allowed = false, // An event-loop worker must never block here.
        .timers_override = &context->timers_override,
        .record_metric   = nullptr, // metric.record is step.after only.
    };
    vayu::core::ElementPipeline::run (vayu::core::Phase::StepBefore, ctx,
    *context->step_elements, outcomes,
    [context] (const vayu::core::CompiledElement& element) {
        return RunContext::load_pipeline_skip_reason (element, context->scripts_override);
    });
    // Tallied here, not only on completion: this is the only phase a
    // `step.before` kind reports in, so an outcome dropped here never reaches
    // `summary["elements"]`, ran or deferred. The scenario path's
    // `run_step_before` (scenario_load.cpp) records on the same edge.
    for (const auto& outcome : outcomes) {
        context->element_tallies.record (outcome);
    }
    // `pre_result.tests` fills only when `script.pre` ran inline (a deferred
    // one never calls `run_pre_script`): the inline half of #1497's assertion
    // tally, as the scenario path folds it.
    for (const auto& test : pre_result.tests) {
        if (test.passed) {
            context->inline_tests_passed.fetch_add (1, std::memory_order_relaxed);
        } else {
            context->inline_tests_failed.fetch_add (1, std::memory_order_relaxed);
        }
    }
}

/**
 * Runs @p context's `requestElements` `step.after` and `step.between` elements
 * for one completed submission: `step.after` against the response,
 * `step.between` for `timer.think`'s non-blocking wait (#1594). The wait is
 * returned for the caller to reserve on a closed-loop @p context through
 * `reserve_think_wait`, there being no `VirtualUser::ready_at_ms` here; an
 * open-loop one skips the timer (#3541). Never blocks: it runs on an event-loop
 * worker, inside the curl completion drain.
 *
 * @return the think time, in ms, the submission's slot is still owed.
 */
int64_t run_request_elements_after_submission (const std::shared_ptr<RunContext>& context,
vayu::Request& request,
const vayu::Response& response,
vayu::http::routes::ScopeOverlay& overlay,
const ResultAnnotations& annotations) {
    const nlohmann::json* row = submission_row (*context, annotations);
    std::vector<vayu::core::ElementOutcome> outcomes;
    vayu::ScriptResult unused_pre_result;
    vayu::ScriptResult post_result;
    // An `mcp` reply's elements read its final response (#3762). The cast only
    // lets the completion's const response travel as `ElementContext::response`,
    // which no kind writes through.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast)
    auto& received = const_cast<vayu::Response&> (response);
    std::optional<vayu::Response> unwrapped;
    vayu::core::ElementContext ctx{
        .request        = request,
        .response       = vayu::http::mcp_element_view (received, unwrapped),
        .run_pre_script = nullptr,
        .run_post_script =
        [&] (const std::string& script) {
            auto& engine = vayu::http::routes::script_engine_for_this_thread (
            context->step_script_config);
            auto scopes = overlay.materialize (context->lifecycle_scopes);
            auto script_ctx = vayu::runtime::ScriptContext::for_test (request, response);
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            context->script_send.apply (script_ctx);
            bind_submission_identity (script_ctx, *context, annotations);
            nlohmann::json stream_events;
            vayu::http::bind_buffered_stream_events (
            script_ctx, response, context->sse_limits, stream_events);
            script_ctx.record_metric = [context] (const std::string& name,
                                       vayu::core::CustomMetricType type, double value) {
                context->metrics_collector->record_custom_metric (name, type, value);
            };
            auto result = vayu::http::routes::execute_script (
            engine, script, script_ctx, "Post-request");
            overlay.replace_from (scopes, context->lifecycle_scopes);
            return result;
        },
        .pre_script_result  = unused_pre_result,
        .post_script_result = post_result,
        .set_variable =
        [&] (std::string_view scope, const std::string& name, const std::string& value) {
            overlay.set (scope, name, value, context->lifecycle_scopes);
        },
        .unset_variable =
        [&] (std::string_view scope, const std::string& name) {
            return overlay.unset (scope, name, context->lifecycle_scopes);
        },
        .should_stop = nullptr,
        // The submission's row under `data.*`, its local scope above the row
        // (#2564), as `scenario_load.cpp` resolves a step's (#3790).
        .resolve_template =
        [&] (const std::string& text) {
            vayu::http::VariableValues vars = context->step_base_vars;
            overlay.apply_onto (vars, context->lifecycle_scopes);
            return vayu::http::resolve_template_with_optional_row (
            text, vars, row, overlay.local_values ());
        },
        .blocking_allowed = false,
        .record_metric =
        [context] (const std::string& name, vayu::core::CustomMetricType type, double value) {
            context->metrics_collector->record_custom_metric (name, type, value);
        },
        .max_body_bytes = context->max_element_body_bytes,
    };

    vayu::core::ElementPipeline::run (vayu::core::Phase::StepAfter, ctx,
    *context->step_elements, outcomes,
    [context] (const vayu::core::CompiledElement& element) {
        return RunContext::load_pipeline_skip_reason (element, context->scripts_override);
    });
    for (const auto& outcome : outcomes) {
        context->element_tallies.record (outcome);
    }
    // Every `assert.*` outcome and required `extract.*` miss lands here, beside
    // an inline `script.post`'s `pm.test` calls; a deferred one adds nothing.
    for (const auto& test : post_result.tests) {
        if (test.passed) {
            context->inline_tests_passed.fetch_add (1, std::memory_order_relaxed);
        } else {
            context->inline_tests_failed.fetch_add (1, std::memory_order_relaxed);
        }
    }

    // `step.between` (#1594): `timer.think`'s load-path counterpart to the
    // sequential run's dispatch, run here instead of blocking a worker. A
    // single-request run's anonymous submissions have no
    // `VirtualUser::ready_at_ms`, so the caller reserves the wait on the run
    // (`RunContext::reserve_think_wait`); an open-loop run skips the timer and
    // reserves nothing (#3541). A fresh context, as `scenario_load.cpp`'s
    // `run_step_between` builds one: a `step.between` kind reads nothing beyond
    // the request it is bound to for `pm.request`.
    std::vector<vayu::core::ElementOutcome> between_outcomes;
    vayu::ScriptResult between_pre_result;
    vayu::ScriptResult between_post_result;
    vayu::core::ElementContext between_ctx{
        .request            = request,
        .response           = nullptr,
        .run_pre_script     = nullptr,
        .run_post_script    = nullptr,
        .pre_script_result  = between_pre_result,
        .post_script_result = between_post_result,
        .set_variable = [] (std::string_view, const std::string&, const std::string&) {},
        .should_stop      = nullptr,
        .blocking_allowed = false,
        .timers_override  = &context->timers_override,
        .record_metric    = nullptr,
    };
    vayu::core::ElementPipeline::run (vayu::core::Phase::StepBetween,
    between_ctx, *context->step_elements, between_outcomes,
    [&context] (const vayu::core::CompiledElement& element) {
        return context->open_loop_timer_skip_reason (element);
    });
    int64_t total_wait_ms = 0;
    for (const auto& outcome : between_outcomes) {
        total_wait_ms += outcome.waited_ms.value_or (0);
        context->element_tallies.record (outcome);
    }
    return total_wait_ms;
}

/// Hands @p request to the event loop and accounts for it, with @p annotations
/// on the record its completion produces. @p sent_request and @p overlay are
/// non-null only for a run carrying `requestElements` (#1594), and then run
/// `step.after` / `step.between` against the response before the shared
/// `handle_result` records it. The slot is held for the longer of the think
/// time and the response's `Retry-After` (#3782), reserved before
/// `handle_result` counts the completion, so the controller never sees it free
/// in between.
void submit_to_loop (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const vayu::Request& request,
const ResultAnnotations& annotations,
std::shared_ptr<vayu::Request> sent_request,
std::shared_ptr<vayu::http::routes::ScopeOverlay> overlay) {
    // Opened before the submit, because the completion can run on a worker
    // before it returns, and closed first, whatever the outcome (#3567).
    const int64_t opened_ms = context->metrics_collector->open_request ();
    context->event_loop->submit (request,
    [context, &db, annotations, opened_ms, sent_request = std::move (sent_request),
    overlay = std::move (overlay)] (size_t, const vayu::Result<vayu::Response>& result) {
        context->metrics_collector->close_open (opened_ms);
        if (result.is_ok ()) {
            int64_t wait_ms = 0;
            if (sent_request && overlay) {
                wait_ms = run_request_elements_after_submission (
                context, *sent_request, result.value (), *overlay, annotations);
            }
            context->reserve_think_wait (
            std::max (wait_ms, context->honour_retry_after (result.value ())));
        }
        handle_result (context, db, result, annotations);
    });
    context->requests_sent++;
}

/**
 * Binds this submission's row, when the run has one, and its identity into
 * @p request and its credentials, through the one binder both load paths drive.
 * Reached only for a run with a reserved token in its request or credentials,
 * or auth waiting on its scripts; the token-free path skips it. That waiting
 * auth is joined into @p late_auth, not applied (#2473); the caller owes it to
 * the residual pass.
 */
DataBindResult bind_submission (vayu::Request& request,
const RunContext& context,
const LoadDataSet* data,
const ResultAnnotations& annotations,
std::optional<vayu::http::Auth>& late_auth) {
    const size_t iteration = vayu::utils::invariant_value (annotations.iteration,
    "every submission claims its iteration before binding");
    const IterationBinding binding{ data == nullptr ?
        nullptr :
        &data->rows.at (vayu::utils::invariant_value (annotations.data_row_index,
        "a run carrying rows claims one per submission")),
        annotations.data_row_index.value_or (0),
        IterationIdentity{ SOLE_VIRTUAL_USER, iteration } };
    // The auth halves are the run's own, not the data set's: a credential
    // carrying the identity defers on a run that has no set at all (issue
    // #1055), and both are empty for a run whose auth the build resolved.
    if (!context.load_auth.after_scripts) {
        return bind_iteration (request, context.load_template,
        context.load_auth.auth, context.load_auth.credentials, binding);
    }
    auto& auth = late_auth.emplace (context.load_auth.auth);
    return bind_iteration_holding_auth (request, context.load_template, auth,
    context.load_auth.credentials, binding);
}

/**
 * One submission of the run's request, with its data row (#993) and iteration
 * identity (#994) bound in when the run carries either.
 *
 * Every strategy submits through here, so a run's rows and the mid-run
 * credential swap reach whichever pacing mode the user picked.
 *
 * A run carrying none of them pays one null test and two `empty()` tests, then
 * submits the same shared request: no copy and no bind, the throughput guard
 * #992 states, kept structurally. It does pay the cursor increment below, one
 * unsynchronised `size_t` on the sole producer thread, which lets every load
 * run tell a deferred script which iteration a sampled response was sent in.
 */
void submit_one_request (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
SubmissionRequest& live) {
    const size_t iteration  = live.claim_submission ();
    const LoadDataSet* data = context->load_data.get ();
    // Every member named: `-Wmissing-field-initializers` is an error in the
    // release build. A single-request run has no step, which is how
    // `handle_result` tells the shapes apart.
    const ResultAnnotations annotations{ data == nullptr ?
        std::nullopt :
        std::optional<size_t> (iteration % data->rows.size ()),
        std::nullopt, iteration, SOLE_VIRTUAL_USER };

    const bool has_step_elements =
    context->step_elements && !context->step_elements->empty ();

    // The credentials are tested beside the request template because they are a
    // third thing to bind (#1055): a run whose only token sits in a credential
    // has no rows and an empty template, and skipping the bind would send it
    // unauthenticated. A `step.before` kind (#1594) is a fourth: it may write
    // into the request, so concurrent submissions each need a copy, where a
    // `step.after`-only kind only reads it back.
    if (sends_the_shared_request (*context)) {
        if (!context->load_unresolved_tokens.empty ()) {
            context->metrics_collector->record_unresolved_token (context->load_unresolved_tokens);
        }
        if (!has_step_elements) {
            submit_to_loop (context, db, live.current (), annotations, nullptr, nullptr);
            return;
        }
        // Nothing to bind and no `step.before` kind, so no per-submission copy
        // of the request; `step.after` / `step.between` still need a stable,
        // isolated request and overlay once the response is back.
        submit_to_loop (context, db, live.current (), annotations,
        std::make_shared<vayu::Request> (live.current ()),
        std::make_shared<vayu::http::routes::ScopeOverlay> ());
        return;
    }

    // Copied per submission because the bind rewrites it, as a scenario step's
    // request is copied per iteration: the shared one stays the template every
    // later row binds against.
    vayu::Request request = live.current ();
    std::optional<vayu::http::Auth> late_auth;
    auto bound = bind_submission (request, *context, data, annotations, late_auth);
    // A path a row bound is filled from what the plan checked; the transfer
    // never opens a small file and never re-checks one.
    if (bound.ok) {
        bound = fill_bound_files (context->file_plan.get (), live.current (), request);
    }
    if (!bound.ok) {
        // Nothing goes on the wire, so nothing completes: this path does the
        // whole accounting a completion would. `requests_sent` is incremented
        // beside the error record so `in_flight()` (sent minus completed) stays
        // honest, as the scenario executor's bind failure does.
        context->requests_sent++;
        context->bind_failures_submitted++;
        handle_result (context, db,
        vayu::Result<vayu::Response> (
        vayu::Error{ vayu::ErrorCode::DataBindingFailed, bound.error }),
        annotations);
        return;
    }

    auto overlay =
    has_step_elements ? std::make_shared<vayu::http::routes::ScopeOverlay> () : nullptr;
    if (has_step_elements && context->step_elements_have_step_before) {
        run_request_elements_step_before (context, request, *overlay, annotations);
    }

    // With `requestElements`, whatever the bind and any `step.before` extractor
    // or script left unresolved is re-resolved once against this submission's
    // overlay (#1594's residual pass, as `scenario_load.cpp`'s
    // `run_step_before` caller does); a run without them only counts the
    // mistake, never refusing it (#1503). The token-free fast path never copies
    // `request` (#992) and is not scanned here: it records
    // `context->load_unresolved_tokens`, scanned once by `start_run` before
    // this loop (#1540). Auth that waited on the scripts (#2473) is applied by
    // that pass; only a run declaring `requestElements` holds any
    // (`LoadAuthPlan::after_scripts`), so the branch below never drops one.
    if (has_step_elements) {
        vayu::http::VariableValues vars = context->step_base_vars;
        overlay->apply_onto (vars, context->lifecycle_scopes);
        const auto unresolved = vayu::http::routes::resolve_load_residuals (
        request, vars, std::move (late_auth));
        if (!unresolved.empty ()) {
            context->metrics_collector->record_unresolved_token (unresolved);
        }
    } else {
        // No per-submission residual pass here (the start-of-run pass, #3253,
        // ran once before the split), so the bind was the last to answer a path
        // value (#1764): whatever still waits is written now, its token
        // verbatim.
        settle_path_variables (request, PathSettle::All);
        if (auto names = vayu::http::routes::unresolved_token_names (request);
        !names.empty ()) {
            context->metrics_collector->record_unresolved_token (names);
        }
    }

    auto sent_request =
    has_step_elements ? std::make_shared<vayu::Request> (request) : nullptr;
    submit_to_loop (context, db, request, annotations, sent_request, overlay);
}

} // namespace

bool submissions_run_the_residual_pass (const RunContext& context,
const StepDataTemplate& bind_template) {
    return context.step_elements && !context.step_elements->empty () &&
    !sends_the_shared_request (context, bind_template);
}

vayu::Request request_as_submitted (const RunContext& context,
const vayu::Request& shared,
const ResultAnnotations& annotations) {
    vayu::Request request = shared;
    if (sends_the_shared_request (context)) {
        settle_shared_request (request);
        return request;
    }
    // `submit_one_request`'s steps in its order, less what the replay cannot
    // reproduce: the `step.before` elements between the bind and the residual
    // pass, and the overlay they wrote, which no sample records.
    std::optional<vayu::http::Auth> late_auth;
    if (!bind_submission (request, context, context.load_data.get (), annotations, late_auth)
        .ok) {
        return request;
    }
    if (context.step_elements && !context.step_elements->empty ()) {
        (void)vayu::http::routes::resolve_load_residuals (
        request, context.step_base_vars, std::move (late_auth));
    } else {
        settle_path_variables (request, PathSettle::All);
    }
    return request;
}

// Declared in load_strategy.hpp - the scenario load executor drives the same
// loop with a different submit_one. See the header for the contract.
void maintain_concurrency (std::shared_ptr<RunContext> context,
const std::function<bool ()>& submit_one,
const std::function<size_t (int64_t)>& target_fn,
const std::function<size_t ()>& budget_fn,
const std::function<bool (int64_t)>& should_continue,
const std::function<std::optional<int64_t> ()>& deferred_wait_ms_fn,
std::optional<int64_t> run_end_ms) {
    using clock     = std::chrono::steady_clock;
    auto start      = clock::now ();
    auto elapsed_ms = [&start] () {
        return std::chrono::duration_cast<std::chrono::milliseconds> (clock::now () - start)
        .count ();
    };

    // closed_loop must be true BEFORE seeding so no early completion's notify
    // is dropped.
    context->closed_loop.store (true, std::memory_order_relaxed);

    // The run's predicate decides whether anything is owed at all, so a 0s
    // duration or a 0-iteration run sends nothing before the time/quota check.
    if (context->should_stop || !should_continue (0)) {
        return;
    }

    // The last target the controller refilled toward, which the end-of-run
    // refill measures its shortfall from.
    size_t last_target = target_fn (0);
    size_t seed        = compute_refill_deficit (last_target, 0, budget_fn ());
    for (size_t i = 0; i < seed && !context->should_stop; ++i) {
        submit_one ();
    }
    update_peak (context);

    // Answers whether the pass was owed a submission and put none in flight:
    // a scenario VU whose every step was skipped (#3540), or whose every
    // submission failed its data bind (#3592, each still counted as an error).
    // The strategy thread is `requests_sent`'s and `bind_failures_submitted`'s
    // only writer, so comparing the two deltas is exact.
    auto refill_toward = [&] (size_t target, size_t at_most) {
        const size_t deficit     = std::min (at_most,
        compute_refill_deficit (target, context->in_flight (), budget_fn ()));
        const size_t sent_before = context->requests_sent.load ();
        const size_t bind_failed_before = context->bind_failures_submitted.load ();
        for (size_t i = 0; i < deficit && !context->should_stop; ++i) {
            // False means the remaining candidates are all deferred or busy;
            // retrying at once re-scans the same VUs for the same answer, so
            // `deferred_wait_ms_fn` picks it up next cycle.
            if (!submit_one ()) {
                break;
            }
        }
        update_peak (context);
        return deficit > 0 &&
        context->requests_sent.load () - sent_before ==
        context->bind_failures_submitted.load () - bind_failed_before;
    };

    int64_t el     = 0;
    bool idle_pass = false;
    while (!context->should_stop) {
        // `deferred_wait_ms_fn` answers only after a cycle where `submit_one`
        // returned false because every eligible candidate was deferred (#1596),
        // not merely without budget, which the `in_flight() < target` predicate
        // handles by blocking until a completion. A deferred user is never in
        // flight, and neither is a pass that sent nothing (#3540), so that
        // predicate is still true and `wait_for` would return at once. The
        // timeout must come from the wait call, and the predicate must become
        // one neither already satisfies: a real completion, seen as
        // `in_flight()` changing from its value when the wait began. The
        // strategy thread is `requests_sent`'s only writer, so until the wait
        // returns it can only fall.
        const size_t in_flight_before = context->in_flight ();
        std::optional<int64_t> defer_wait_ms =
        deferred_wait_ms_fn ? deferred_wait_ms_fn () : std::nullopt;

        {
            std::unique_lock<std::mutex> lk (context->refill_mtx);
            if (defer_wait_ms || idle_pass) {
                const auto bound = std::chrono::milliseconds (std::min (
                CONTROLLER_TICK_MS, defer_wait_ms.value_or (CONTROLLER_TICK_MS)));
                context->refill_cv.wait_for (lk, bound, [&] () {
                    return context->should_stop.load () ||
                    context->in_flight () != in_flight_before;
                });
            } else {
                context->refill_cv.wait_for (
                lk, std::chrono::milliseconds (CONTROLLER_TICK_MS), [&] () {
                    return context->should_stop.load () ||
                    context->in_flight () < target_fn (elapsed_ms ());
                });
            }
        }

        el = elapsed_ms ();
        if (context->should_stop || !should_continue (el)) {
            break;
        }
        last_target = target_fn (el);
        idle_pass = refill_toward (last_target, std::numeric_limits<size_t>::max ());
    }

    // Only a run the clock ended: a stop owes nothing, and a loop that left
    // before `run_end_ms` ended on its predicate. The refill owes only the
    // target the last wake fell short of (#2913), never a replacement for what
    // completed during it, since the run's time is up (#3545).
    if (run_end_ms && !context->should_stop && el >= *run_end_ms) {
        const size_t end_target = target_fn (*run_end_ms - 1);
        refill_toward (end_target, end_target - std::min (end_target, last_target));
    }
}

// ============================================================================
// Constant Load Strategy
// ============================================================================

class ConstantLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config  = context->config;
        int64_t duration_ms = duration_field_ms (
        config, "duration", constants::run_config::DEFAULT_DURATION_MS);
        SubmissionRequest live (context, request);

        // Chosen by mode (#2396): `constant_concurrency`, and a mode-less body
        // with no rate, hold N in flight even when a stray rate rides along.
        const double target_rps = open_loop_rate (config);
        if (target_rps > 0.0) {
            run_rate_limited (context, db, live, duration_ms, target_rps);
        } else {
            // Concurrency-based mode: closed-loop, hold ~N in flight.
            size_t concurrency = static_cast<size_t> (
            config.value ("concurrency", constants::run_config::DEFAULT_CONCURRENCY));

            vayu::utils::log_info ("run", "Starting Constant Load Test (Concurrency-Based)");
            vayu::utils::log_info (
            "run", "  Duration: " + std::to_string (duration_ms) + " ms");
            vayu::utils::log_info ("run", "  Concurrency: " + std::to_string (concurrency));

            auto submit_one = [&context, &db, &live] () {
                submit_one_request (context, db, live);
                return true;
            };

            maintain_concurrency (
            context, submit_one, [concurrency] (int64_t) { return concurrency; }, // target(t) = N
            [] () { return std::numeric_limits<size_t>::max (); }, // unbounded budget
            [duration_ms] (int64_t el) { return el < duration_ms; }); // stop at duration
        }
    }

    private:
    /**
     * Pays out the requests one tick owes, up to the in-flight cap's headroom.
     * Requests the cap refuses are dropped at the instant they came due, not
     * deferred: deferring lets a saturated run submit its backlog past the
     * deadline and still report itself on rate. Returns how many were
     * submitted.
     */
    static size_t submit_due (const std::shared_ptr<RunContext>& context,
    vayu::db::Database& db,
    SubmissionRequest& live,
    size_t due,
    size_t max_pending) {
        const size_t in_flight = context->in_flight ();
        const size_t headroom = max_pending > in_flight ? max_pending - in_flight : 0;
        const size_t to_submit = std::min (due, headroom);
        if (due > to_submit) {
            context->metrics_collector->record_drop_batch (due - to_submit);
        }
        size_t sent = 0;
        for (size_t i = 0; i < to_submit && !context->should_stop; ++i) {
            // The submission every other mode makes, rows and all: a copy here
            // would stop receiving what that one is given.
            submit_one_request (context, db, live);
            sent++;
        }
        // After the loop, so the reading counts only what was submitted: the
        // requests the cap refused above never entered in_flight() (#2912).
        update_peak (context);
        return sent;
    }

    /**
     * Settle what one tick owes: the backlog a stall left beyond
     * `MAX_CATCH_UP_BACKLOG` is skipped and recorded, the rest goes through
     * `submit_due` and its maxInFlight cap. Returns how many were submitted.
     */
    static size_t pay_out_tick (const std::shared_ptr<RunContext>& context,
    vayu::db::Database& db,
    SubmissionRequest& live,
    const TickPayout& payout,
    double target_rps,
    size_t max_pending) {
        if (payout.skipped > 0) {
            const double stalled_ms =
            static_cast<double> (payout.skipped) * 1000.0 / target_rps;
            context->metrics_collector->record_skipped_batch (payout.skipped, stalled_ms);
        }
        if (payout.to_submit == 0) {
            return 0;
        }
        return submit_due (context, db, live, payout.to_submit, max_pending);
    }

    /**
     * Waits out the remainder of a tick. Oversleeping corrects itself in rate
     * (the next tick accrues the extra time), so `sendRate` never shows what
     * this does; only a target timestamping its arrivals does.
     *
     * Not for 15.6ms rounding (#1161): the run's event loop holds
     * `platform::HighResolutionTimerScope` while it exists, so the resolution
     * is 1ms while a run sends, on the pacing thread too. The spin is for the
     * residual: even at 1ms, `sleep_for` returns ~0.6-1.8ms late, so a
     * generator that sleeps a whole remainder lands late every tick and pays
     * the overshoot back as a double dispatch on the next.
     *
     * So every tick ends on a spin and only the stretch before it is slept
     * (#1370, on every platform with #1667's per-platform tail): the overshoot
     * lands in the tail, not the arrival gap, and the spin is bounded by the
     * tail, not the tick, so its cost does not grow as the rate falls. A
     * remainder no longer than the tail is spun whole, which every tick from
     * ~500 RPS up is (`tick_us` is 1000us there).
     *
     * The sleep is `platform::sleep_until_precise`. Linux and macOS wait
     * absolutely (`clock_nanosleep` / `mach_wait_until`) and would be accurate
     * without the tail, but it stays as on Windows: no platform's wakeup
     * latency is trusted for a tick's last stretch, and the tail is cheap.
     */
    static void wait_for_next_tick (const std::shared_ptr<RunContext>& context,
    std::chrono::steady_clock::time_point next_tick) {
        const auto sleep_us = std::chrono::duration_cast<std::chrono::microseconds> (
        next_tick - std::chrono::steady_clock::now ())
                              .count ();
        if (sleep_us <= 100) {
            return;
        }
        const int64_t tail = constants::pacing::spin_tail_us (sleep_us);
        const int64_t leg  = tick_sleep_leg_us (sleep_us, tail);
        if (leg > 0) {
            vayu::platform::sleep_until_precise (
            next_tick - std::chrono::microseconds (tail));
        }
        while (std::chrono::steady_clock::now () < next_tick && !context->should_stop) {
            /* spin */
        }
    }

    /**
     * Rate-limited mode: submit what each tick owes, skip what a stall owed
     * beyond the catch-up window, drop what the in-flight cap refuses, and
     * stop at the deadline.
     */
    static void run_rate_limited (const std::shared_ptr<RunContext>& context,
    vayu::db::Database& db,
    SubmissionRequest& live,
    int64_t duration_ms,
    double target_rps) {
        vayu::utils::log_info ("run", "Starting Constant Load Test (Rate-Limited)");
        vayu::utils::log_info ("run", "  Duration: " + std::to_string (duration_ms) + " ms");
        vayu::utils::log_info ("run", "  Target RPS: " + std::to_string (target_rps));

        // The same call the final accrual makes at the deadline, so a run's
        // sent + skipped + dropped is this count exactly.
        const auto duration        = std::chrono::milliseconds (duration_ms);
        const size_t expected      = requests_owed_by (target_rps, duration);
        context->requests_expected = expected;

        // Tick length: the request interval up to 1000 RPS, 1ms above it (below
        // 1ms would busy-spin). `requests_owed_by` reads how many a tick owes
        // off the time since the start, so 1500 RPS owes 1 or 2 per 1ms tick
        // and a late tick owes what the ticks it swallowed would have.
        const int64_t base_interval_us = static_cast<int64_t> (1000000.0 / target_rps);
        const int64_t tick_us = std::max<int64_t> (base_interval_us, 1000);

        // Read once: the config cannot change mid-run.
        const size_t max_pending = context->config.value ("maxInFlight",
        std::max (static_cast<size_t> (target_rps * 10.0), size_t{ 1000 }));

        vayu::utils::log_debug ("run", "Submission config",
        { { "tickUs", tick_us }, { "maxInFlight", max_pending },
        { "expectedRequests", expected } });

        const auto test_start   = std::chrono::steady_clock::now ();
        const auto duration_end = test_start + duration;
        auto scheduled          = test_start; // when the current tick was due
        size_t taken            = 0;          // submitted + dropped + skipped
        size_t submitted        = 0;

        while (!context->should_stop) {
            const auto now = std::chrono::steady_clock::now ();

            // Time-bound, not quota-bound: never accrue past the deadline, so
            // the final tick pays only its slice of the window and no backlog
            // reaches past it.
            const auto accrue_to = std::min (now, duration_end);
            const size_t owed = requests_owed_by (target_rps, accrue_to - test_start);
            if (owed > taken) {
                const TickPayout payout =
                split_tick_backlog (target_rps, owed, taken, scheduled - test_start);
                submitted +=
                pay_out_tick (context, db, live, payout, target_rps, max_pending);
                taken = owed;
            }

            if (now >= duration_end) {
                break;
            }

            // The last request is owed at the deadline itself when the
            // product is whole, so the final wait ends there, not a tick past.
            scheduled =
            std::min (accrue_to + std::chrono::microseconds (tick_us), duration_end);
            wait_for_next_tick (context, scheduled);
        }

        vayu::utils::log_info ("run", "Submitted " + std::to_string (submitted) + " requests");
    }
};

// ============================================================================
// Iterations Load Strategy
// ============================================================================

class IterationsLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;
        SubmissionRequest live (context, request);
        size_t iterations = static_cast<size_t> (
        config.value ("iterations", constants::run_config::DEFAULT_ITERATIONS));
        size_t concurrency = static_cast<size_t> (config.value (
        "concurrency", constants::run_config::DEFAULT_ITERATIONS_CONCURRENCY));

        vayu::utils::log_info ("run", "Starting Iterations Load Test");
        vayu::utils::log_info ("run", "  Iterations: " + std::to_string (iterations));
        vayu::utils::log_info ("run", "  Concurrency: " + std::to_string (concurrency));

        context->requests_expected = iterations;

        auto submit_one = [&context, &db, &live] () {
            submit_one_request (context, db, live);
            return true;
        };

        maintain_concurrency (
        context, submit_one, [concurrency] (int64_t) { return concurrency; }, // target = N
        [context, iterations] () -> size_t { // budget = M - sent
            size_t sent = context->requests_sent.load ();
            return sent < iterations ? iterations - sent : 0;
        },
        [context, iterations] (int64_t) { // stop at M
            return context->requests_sent.load () < iterations;
        });

        vayu::utils::log_info ("run",
        "Submitted " + std::to_string (context->requests_sent.load ()) + " requests");
    }
};

// ============================================================================
// Ramp Up Load Strategy
// ============================================================================

class RampUpLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;
        SubmissionRequest live (context, request);

        int64_t duration_ms = duration_field_ms (
        config, "duration", constants::run_config::DEFAULT_DURATION_MS);
        int64_t ramp_duration_ms = duration_field_ms (config, "rampUpDuration",
        constants::run_config::DEFAULT_RAMP_DURATION_MS);

        size_t start_concurrency  = static_cast<size_t> (config.value (
        "startConcurrency", constants::run_config::DEFAULT_START_CONCURRENCY));
        size_t target_concurrency = static_cast<size_t> (
        config.value ("concurrency", constants::run_config::DEFAULT_CONCURRENCY));

        vayu::utils::log_info ("run", "Starting Ramp Up Load Test");
        vayu::utils::log_info (
        "run", "  Total Duration: " + std::to_string (duration_ms) + " ms");
        vayu::utils::log_info ("run",
        "  Ramp Up Duration: " + std::to_string (ramp_duration_ms) + " ms");
        vayu::utils::log_info (
        "run", "  Start Concurrency: " + std::to_string (start_concurrency));
        vayu::utils::log_info (
        "run", "  Target Concurrency: " + std::to_string (target_concurrency));

        auto submit_one = [&context, &db, &live] () {
            submit_one_request (context, db, live);
            return true;
        };

        // target(t): linear from start_concurrency to target_concurrency over
        // ramp_duration_ms, then flat at target_concurrency. Descends correctly
        // when the start is above the target - see ramp_target_concurrency.
        auto target_fn = [start_concurrency, target_concurrency,
                         ramp_duration_ms] (int64_t el) -> size_t {
            return ramp_target_concurrency (
            start_concurrency, target_concurrency, ramp_duration_ms, el);
        };

        maintain_concurrency (
        context, submit_one, target_fn,
        [] () { return std::numeric_limits<size_t>::max (); },
        [duration_ms] (int64_t el) { return el < duration_ms; }, {}, duration_ms);
    }
};

// ============================================================================
// Capacity Discovery Load Strategy
// ============================================================================

namespace {

/// The steady clock in the milliseconds `collect_metrics` reads its ticks in,
/// which `RunContext::CapacityProgress` is measured against.
int64_t steady_clock_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

} // namespace

CapacitySearch::CapacitySearch (CapacityConfig config, std::shared_ptr<RunContext> context)
: config_ (config), context_ (std::move (context)) {
}

bool CapacitySearch::advance (int64_t elapsed_ms) {
    if (stop_reason_ != nullptr) {
        return false;
    }
    // The deadline lives here, not in the controller: it is the one stop
    // condition about time rather than the service, and the controller holds no
    // clock.
    if (elapsed_ms >= config_.deadline_ms) {
        stop_reason_ = capacity_stop::DEADLINE;
        return false;
    }

    collect_tick ();

    if (current_ == 0) {
        open_level (decide_next_level (config_, history_).next_concurrency, elapsed_ms);
        return true;
    }
    if (elapsed_ms - level_started_ms_ < config_.step_duration_ms) {
        return true;
    }
    const bool has_latency_or_failure = level_samples_ > 0 || level_failed_ > 0;
    if (!has_latency_or_failure || level_completed_ == 0) {
        // A level is judged on evidence of both kinds and stays open until it
        // has them. No timed completion and no counted failure (#2384: a
        // timeout is timed) would read as a service that answered instantly; a
        // refused connection records no latency but is counted, so a level of
        // only refusals is still judged. No completion counted yet would read
        // as a 0% error share: the status snapshot can lag the histogram by a
        // tick (#2815). A search that never gets both ends on its deadline,
        // reporting only the levels it judged.
        return true;
    }

    history_.push_back ({ current_,
    rps_windows_ > 0 ? rps_sum_ / static_cast<double> (rps_windows_) : 0.0,
    level_p99_ms_, level_error_pct_, level_samples_ });

    const CapacityDecision decision = decide_next_level (config_, history_);
    switch (decision.action) {
    case CapacityAction::Stop:
        stop_reason_ = decision.stop_reason;
        return false;
    case CapacityAction::Hold:
    case CapacityAction::StepUp:
        open_level (decision.next_concurrency, elapsed_ms);
        return true;
    }
    return true;
}

CapacitySummary CapacitySearch::finish () {
    const char* reason = stop_reason_;
    if (reason == nullptr) {
        reason = context_->stop_decides_outcome () ? capacity_stop::STOPPED :
                                                     capacity_stop::DEADLINE;
    }
    publish_progress (reason, steady_clock_ms ());
    return summarize_capacity (config_, history_, reason);
}

void CapacitySearch::publish_progress (const char* stop_reason, int64_t ended_steady_ms) {
    RunContext::CapacityProgress progress;
    progress.level                   = current_;
    progress.level_started_steady_ms = level_started_steady_ms_;
    progress.ended_steady_ms         = ended_steady_ms;
    progress.levels_judged           = history_.size ();
    progress.stop_reason             = stop_reason;
    context_->publish_capacity_progress (progress);
}

void CapacitySearch::open_level (size_t level, int64_t now_ms) {
    current_                 = level;
    level_started_ms_        = now_ms;
    level_started_steady_ms_ = steady_clock_ms ();
    ticks_seen_              = 0;
    rps_windows_             = 0;
    rps_sum_                 = 0.0;
    level_epoch_             = 0;
    level_samples_           = 0;
    level_p99_ms_            = 0.0;
    level_completed_         = 0;
    level_failed_            = 0;
    level_error_pct_         = 0.0;
    // Adopt the newest published sequence so the first tick this level
    // counts is one produced after the target moved, not the one already
    // sitting there describing the previous level.
    if (auto tick = context_->latest_live_tick ()) {
        last_sequence_ = tick->sequence;
    }
    // The judged count moves only just before a level opens or the search
    // ends, so publishing here and in finish keeps the frame's count current.
    publish_progress (nullptr, 0);
}

// The level histogram's reset is requested on the last settle tick, not when
// the level opens, so the producer, which knows nothing of SETTLE_TICKS, resets
// it before sampling the first window this search counts.
static_assert (constants::capacity::SETTLE_TICKS > 0,
"the level reset is requested on the last settle tick");

void CapacitySearch::collect_tick () {
    auto tick = context_->latest_live_tick ();
    if (!tick || tick->sequence <= last_sequence_) {
        return;
    }
    last_sequence_ = tick->sequence;
    ++ticks_seen_;
    // The first ticks after a target change measure the transition - the
    // in-flight count is still climbing - so they are watched but not
    // counted.
    if (ticks_seen_ < constants::capacity::SETTLE_TICKS) {
        return;
    }
    if (ticks_seen_ == constants::capacity::SETTLE_TICKS) {
        level_epoch_ = context_->request_level_reset ();
        return;
    }
    rps_sum_ += tick->current_rps;
    ++rps_windows_;
    // A tick under an older epoch was produced before the reset applied, and
    // its level histogram still holds the previous level or the settle ticks.
    if (tick->level.epoch == level_epoch_) {
        level_samples_   = tick->level.samples;
        level_p99_ms_    = tick->level.p99_ms;
        level_completed_ = tick->level.completed;
        level_failed_    = tick->level.failed;
        level_error_pct_ = tick->level.error_pct ();
    }
}

class CapacityLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;

        const int64_t deadline_ms =
        duration_field_ms (config, "duration", constants::capacity::DEADLINE_MS);
        const int64_t step_ms = duration_field_ms (
        config, "stepDuration", constants::capacity::STEP_DURATION_MS);
        const CapacityConfig capacity_config =
        capacity_config_from (config, step_ms, deadline_ms);

        vayu::utils::log_info ("run", "Starting Capacity Discovery Load Test");
        vayu::utils::log_info ("run",
        "  SLO: p99 < " + std::to_string (capacity_config.slo_ms) +
        " ms, errors <= " + std::to_string (capacity_config.max_error_pct) + "%");
        vayu::utils::log_info ("run",
        "  Step duration: " + std::to_string (capacity_config.step_duration_ms) + " ms");
        vayu::utils::log_info ("run",
        "  Concurrency: " + std::to_string (capacity_config.start_concurrency) +
        " -> " + std::to_string (capacity_config.max_concurrency));
        vayu::utils::log_info ("run", "  Deadline: " + std::to_string (deadline_ms) + " ms");

        // Through `SubmissionRequest` like every mode (#993): a capacity search
        // binds data rows the same way and picks up a credential the refresh
        // watchdog renewed mid-search, which submitting the built request
        // directly would miss.
        SubmissionRequest live (context, request);
        auto submit_one = [&context, &db, &live] () {
            submit_one_request (context, db, live);
            return true;
        };

        CapacitySearch search (capacity_config, context);

        maintain_concurrency (
        context, submit_one, [&search] (int64_t) { return search.level (); },
        [] () { return std::numeric_limits<size_t>::max (); },
        [&search] (int64_t el) { return search.advance (el); });

        // Written before this frame returns and read by execute_load_test after
        // it, on the same thread, so the summary sees a complete search.
        // `emplace` hands back what it stored, so the log line reads the
        // engaged optional.
        const CapacitySummary& capacity = context->capacity.emplace (search.finish ());
        vayu::utils::log_info ("run",
        "Capacity search stopped: " + capacity.stop_reason + " (" +
        std::to_string (capacity.levels.size ()) + " levels measured)");
    }
};

// ============================================================================
// Factory
// ============================================================================

std::unique_ptr<LoadStrategy> LoadStrategy::create (const nlohmann::json& config) {
    std::string mode = config.value ("mode", "constant_rps");
    auto type        = parse_load_test_type (mode);

    if (!type) {
        if (config.contains ("iterations")) {
            return std::make_unique<IterationsLoadStrategy> ();
        }
        return std::make_unique<ConstantLoadStrategy> ();
    }

    switch (*type) {
    case LoadTestType::ConstantRps:
    case LoadTestType::ConstantConcurrency:
        return std::make_unique<ConstantLoadStrategy> ();
    case LoadTestType::Iterations:
        return std::make_unique<IterationsLoadStrategy> ();
    case LoadTestType::RampUp: return std::make_unique<RampUpLoadStrategy> ();
    case LoadTestType::Capacity:
        return std::make_unique<CapacityLoadStrategy> ();
    }

    return std::make_unique<ConstantLoadStrategy> ();
}

// Beside `create` because it reads the same mapping: a mode this file does not
// know falls back the way `create` does.
bool returns_at_send_deadline (const nlohmann::json& config) {
    const auto type = parse_load_test_type (config.value ("mode", "constant_rps"));
    if (!type) {
        return !config.contains ("iterations");
    }
    return *type != LoadTestType::Iterations;
}

bool runs_capacity_search (const nlohmann::json& config) noexcept {
    const auto mode = config.find ("mode");
    return mode != config.end () && mode->is_string () &&
    parse_load_test_type (mode->get_ref<const std::string&> ()) == LoadTestType::Capacity;
}

} // namespace vayu::core
