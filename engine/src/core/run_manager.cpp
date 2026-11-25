/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <functional>
#include <iostream>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/core/script_config.hpp"
#include "vayu/core/trailing_window.hpp"
#include "vayu/core/worker_count.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/retry_after.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/set_cookie_limits.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/log_text.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// Once-ever, not once-per-run: a container or sandbox that denies a raised
/// scheduling priority denies it the same way on every run, so repeating the
/// warning would only restate what the operator was already told.
std::atomic<bool> g_pacing_priority_denied_logged{ false };

/// Raises the calling thread's scheduling priority above default, best-effort,
/// logging a denial once ever; a helper so `execute_load_test` does not carry
/// the branch (`readability-function-cognitive-complexity`).
void raise_pacing_thread_priority () {
    if (!vayu::platform::raise_current_thread_priority () &&
    !g_pacing_priority_denied_logged.exchange (true)) {
        vayu::utils::log_warning ("run",
        "Could not raise the load-run pacing thread's scheduling priority; "
        "continuing at the default priority");
    }
}

/// @p config's @p key when it is a non-empty string, the one shape the route
/// lets an id through as (`requestId`, `environmentId`, `collectionId`);
/// nothing otherwise.
std::optional<std::string> named_id (const nlohmann::json& config, const char* key) {
    const auto it = config.find (key);
    if (it == config.end () || !it->is_string () || it->get<std::string> ().empty ()) {
        return std::nullopt;
    }
    return it->get<std::string> ();
}

/// The collection scope a single-request run's scripts read: its
/// `lifecycleElements` (#1573), its `requestElements`, the deferred `tests`
/// replay and the start-of-run pass. `POST /execute`'s rule
/// (`scope_collection_id`): the linked request's collection, else the composed
/// `collectionId` (#3461), else none.
std::string single_request_lifecycle_collection_id (vayu::db::Database& db,
const nlohmann::json& config) {
    return vayu::http::routes::scope_collection_id (
    db, named_id (config, "requestId"), named_id (config, "collectionId"));
}

/**
 * The clock every *elapsed* figure is measured on. `now_ms()` is wall time,
 * which NTP steps and the user can set, so a run spanning an adjustment would
 * report a duration that never happened, or a negative one. Durations come from
 * here and timestamps from `now_ms()`: a tick's `timestamp` is a point a reader
 * compares with their own clock, its `elapsedSeconds` a length.
 *
 * The epoch is arbitrary: a value means something only against another from
 * this function.
 */
inline int64_t steady_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

/**
 * One deferred replay: the scripts, the samples they run against, and the
 * identity `pm.info` reports meanwhile. A single-request run builds one; a
 * scenario load run one per scripted step. The replay code is the same either
 * way, so the two shapes cannot drift into reporting a pass differently.
 */
struct ScriptReplay {
    /// One entry per `script.post` element, in compile order, each executed
    /// on its own (#3125): joined, two elements that both declare `const json`
    /// are a SyntaxError here while Send and a collection run pass them.
    const std::vector<std::string>* scripts = nullptr;
    /// `pm.request` for every sample, unless @ref request_as_sent is set.
    const vayu::Request* request = nullptr;
    /// The request a sample was sent as, re-derived per sample (#3460); unset
    /// where the replay has no run behind it to re-derive from.
    std::function<vayu::Request (const ResponseSample&)> request_as_sent;
    const std::vector<ResponseSample>* samples = nullptr;
    /// The run's data rows, so a sampled iteration reads the row it was bound
    /// to as `pm.iterationData`. Null for a run sent without `data`.
    const std::vector<nlohmann::json>* data_rows = nullptr;
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    /// Prefixed to every failure message so a scenario's failures name their
    /// step. Empty for a single-request run, whose failures need no qualifier.
    std::string failure_prefix;
    /// The caps a streamed sample's events are parsed back under (#657), read
    /// once for the run as `SseStreamRequest::limits` is for a stream, so every
    /// sample is bounded by one rule rather than by the settings as each replay
    /// reached it.
    vayu::http::SseLimits sse_limits;
    /// What a `pm.sendRequest` from this script inherits (#1188, #1256, #2833,
    /// #2841), built once for the pass by `validate_scripts`.
    vayu::runtime::ScriptSendInputs send;
    /// What a `pm.cookies` read throws here (#1501), by the per-branch rule
    /// `failure_prefix` follows: a scenario step *did* carry per-VU cookies
    /// during the run, just not into this after-the-fact replay against a
    /// recorded sample; a single-request run never had a virtual user or cookie
    /// state.
    const char* cookie_read_refusal = nullptr;
};

/**
 * The failures a deferred pass saw, one entry per distinct message. A script
 * failing on every sampled response fails with the same text each time, so
 * recording each occurrence would spend the whole cap on one assertion (#3127).
 * The step prefix is part of a message's identity: the same text from two steps
 * is two failures. Every distinct message is counted, kept or not, so
 * `distinct ()` stays true past the cap and the occurrences of all of them sum
 * to `totalFailed`.
 */
struct ReplayFailures {
    /// First-seen order, at most MAX_FAILURE_MESSAGES.
    std::vector<std::string> kept;
    /// Every distinct message, kept or turned away, with how often it failed.
    std::unordered_map<std::string, size_t> occurrences;

    void record (std::string message) {
        const auto [entry, first_seen] =
        occurrences.try_emplace (std::move (message), 0);
        ++entry->second;
        if (first_seen && kept.size () < vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
            kept.push_back (entry->first);
        }
    }

    [[nodiscard]] size_t distinct () const {
        return occurrences.size ();
    }
};

/**
 * Tallies one replayed script's verdict into @p totals.
 *
 * `result.tests` is filled whether or not the script then threw, so it is read
 * first: a mixed pass/fail script must not collapse into one opaque failure
 * (#1502). A throw after tests ran (or a failed `pm.request` writeback) is a
 * second, distinct failure recorded beside them, as `script_errored`
 * distinguishes in the design path.
 *
 * A script the run's Stop cut short (its `pm.sendRequest` cancelled, #3371, or
 * the script itself ended, #3460) is not tallied: the run ended under it, so it
 * judged nothing.
 */
template <typename RecordFailure>
void tally_replay_result (const vayu::ScriptResult& result,
ScriptValidationTotals& totals,
RecordFailure&& record_failure) {
    if (result.ended_by_stop ()) {
        return;
    }
    if (!result.tests.empty ()) {
        for (const auto& test : result.tests) {
            if (test.passed) {
                totals.passed++;
            } else {
                totals.failed++;
                record_failure (test.name + ": " + test.error_message);
            }
        }
        if (!result.success && !result.error_message.empty ()) {
            totals.failed++;
            record_failure ("Script error: " + result.error_message);
        }
    } else if (result.success) {
        // Script ran but had no pm.test() calls - count as passed
        totals.passed++;
    } else {
        totals.failed++;
        record_failure ("Script error: " + result.error_message);
    }
}

/// The response a recorded sample stands for, as a script reads it.
/// `body_truncated` stays false: the reservoir copies `Response::body`, whose
/// transfer the byte cap already ended if it was exceeded; `CapturedExchange`
/// is the path that truncates.
vayu::Response sample_response (const ResponseSample& sample) {
    vayu::Response response;
    response.status_code      = sample.status_code;
    response.status_text      = sample.status_text;
    response.body             = sample.body;
    response.headers          = sample.headers;
    response.timing.total_ms  = sample.latency_ms;
    response.stream_events    = sample.stream_events;
    response.stream_text_path = sample.stream_text_path;
    return response;
}

/**
 * The context every script of @p replay reads for one sample. Read-only for the
 * engine (`execute` takes it by `const&` and opens a fresh JavaScript context
 * per call), so one serves each element in turn; only a scope write carries
 * between elements, through @p scopes. @p request, @p response and
 * @p stream_events are bound by address and must outlive every execute that
 * reads the result.
 */
vayu::runtime::ScriptContext replay_context (const ScriptReplay& replay,
vayu::http::routes::ScriptVariableScopes& scopes,
const ResponseSample& sample,
const vayu::Request& request,
const vayu::Response& response,
nlohmann::json& stream_events) {
    auto script_ctx = vayu::runtime::ScriptContext::for_test (request, response);
    // All four scopes, through the one function that knows which a script may
    // write (#728); binding only an empty `environment` made a test script pass
    // on Send and fail on every replay.
    vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
    script_ctx.cookie_read_refusal = replay.cookie_read_refusal;
    script_ctx.request_id          = replay.request_id;
    script_ctx.request_name        = replay.request_name;
    // The iteration this response was sent in and the virtual user that sent
    // it, both claimed on the submission path before the send (#994). #300's
    // ruling stands: it refuses reporting a *reservoir position* as an
    // iteration number, and neither is one. `iterationCount` stays absent: a
    // duration-bounded run has no total, and a script that could read it in one
    // mode and not the other is worse than one that never can.
    script_ctx.iteration = sample.iteration;
    script_ctx.vu        = sample.vu;
    replay.send.apply (script_ctx);
    if (replay.data_rows != nullptr && sample.data_row_index &&
    *sample.data_row_index < replay.data_rows->size ()) {
        script_ctx.iteration_data = &(*replay.data_rows)[*sample.data_row_index];
    }
    // `pm.response.events` for a sampled stream (issue #657), parsed here at
    // the end of the run rather than copied on the completion path: the body
    // already is the event list.
    vayu::http::bind_buffered_stream_events (
    script_ctx, response, replay.sse_limits, stream_events);
    return script_ctx;
}

/// Whether the run's Stop or the engine shutting down has ended a replay
/// whose scripts take @p send (#3460): both raise the flag those scripts are
/// stopped by.
bool replay_stopped (const vayu::runtime::ScriptSendInputs& send) {
    return send.stop != nullptr && send.stop->load ();
}

/// Marks @p result, from a script that timed out, as not replayed against the
/// @p samples_after samples left (#3460): its deadline is its own, so each
/// could wait it out again, and at the 5 s default a thousand samples is most
/// of an hour after the run finished sending.
void note_not_replayed (vayu::ScriptResult& result, size_t samples_after) {
    if (samples_after == 0) {
        return;
    }
    const std::string note = "timed out, not replayed against the remaining " +
    std::to_string (samples_after) + (samples_after == 1 ? " sample" : " samples");
    result.success = false;
    result.error_message =
    result.error_message.empty () ? note : result.error_message + " (" + note + ")";
}

/**
 * Runs every script of @p replay against one sample, each on its own. A throw
 * is that element's failure and the next elements still run, as a Send's
 * pipeline runs the next level after one throws. Every line a script logged
 * goes to @p console, whatever its verdict. A script marked in @p timed_out is
 * skipped, and one that times out here is marked, with @p samples_after the
 * samples still to come. A Stop ends the sample between two scripts.
 */
template <typename RecordFailure>
void replay_sample (vayu::runtime::ScriptEngine& engine,
vayu::http::routes::ScriptVariableScopes& scopes,
const ScriptReplay& replay,
const ResponseSample& sample,
size_t samples_after,
std::vector<bool>& timed_out,
ScriptValidationTotals& totals,
DistinctMessageSample& console,
RecordFailure& record_failure) {
    std::optional<vayu::Request> sent;
    if (replay.request_as_sent) {
        sent = replay.request_as_sent (sample);
    }
    const vayu::Request& request = sent ? *sent : *replay.request;
    // A sample keeps no reply reading, so an `mcp` one is read again off its
    // bytes by the completion's rule, for `pm.response.mcp` (#3762).
    vayu::Response response = sample_response (sample);
    vayu::http::attach_mcp_reply (request, response);
    nlohmann::json stream_events;
    const auto script_ctx =
    replay_context (replay, scopes, sample, request, response, stream_events);
    const auto& scripts = *replay.scripts;
    for (size_t i = 0; i < scripts.size (); ++i) {
        if (timed_out[i]) {
            continue;
        }
        if (replay_stopped (replay.send)) {
            return;
        }
        try {
            vayu::ScriptResult result = engine.execute (scripts[i], script_ctx);
            for (const auto& line : result.console_output) {
                console.offer (console_message (line));
            }
            if (result.timed_out) {
                timed_out[i] = true;
                note_not_replayed (result, samples_after);
            }
            tally_replay_result (result, totals, record_failure);
        } catch (const std::exception& e) {
            totals.failed++;
            record_failure ("Exception: " + std::string (e.what ()));
        }
    }
}

/**
 * Replays @p replay's scripts against its samples, tallying the results.
 *
 * @param scopes The pass's copy of the run's scopes as setup left them, shared
 *        by every replay of the pass and mutated in place by a script's
 *        `set()`; `validate_scripts` says why those writes are never persisted.
 * @param failures Recorded into; at most MAX_FAILURE_MESSAGES distinct messages
 *        across the whole run, so a forty-step plan does not multiply the cap
 *        by forty.
 * @return The tallies and this replay's own console lines, never merged with
 *         another step's. `sampled` counts the samples reached, fewer than held
 *         when a Stop or engine shutdown ended it (#3460).
 */
ScriptValidationTotals run_replay (vayu::runtime::ScriptEngine& engine,
vayu::http::routes::ScriptVariableScopes& scopes,
const ScriptReplay& replay,
ReplayFailures& failures) {
    ScriptValidationTotals totals;
    DistinctMessageSample console;
    std::vector<bool> timed_out (replay.scripts->size (), false);

    auto record_failure = [&failures, &replay] (const std::string& message) {
        failures.record (replay.failure_prefix + message);
    };

    const auto& samples = *replay.samples;
    for (size_t i = 0; i < samples.size () && !replay_stopped (replay.send); ++i) {
        ++totals.sampled;
        // A sample whose context cannot be built runs none of its scripts and
        // fails once.
        try {
            replay_sample (engine, scopes, replay, samples[i],
            samples.size () - i - 1, timed_out, totals, console, record_failure);
        } catch (const std::exception& e) {
            totals.failed++;
            record_failure ("Exception: " + std::string (e.what ()));
        }
    }

    totals.console         = console.kept ();
    totals.console_dropped = console.dropped ();
    return totals;
}
} // namespace

SamplingRetention read_retention (const MetricsCollector& mc) {
    SamplingRetention retention;
    retention.errors_dropped               = mc.errors_dropped ();
    retention.success_traces_dropped       = mc.success_results_dropped ();
    retention.slow_traces_dropped          = mc.slow_results_dropped ();
    retention.response_samples_dropped     = mc.response_samples_dropped ();
    retention.exemplars_dropped            = mc.exemplar_results_dropped ();
    retention.sample_bodies_dropped        = mc.sample_bodies_dropped ();
    retention.response_bodies_captured     = mc.response_bodies_captured ();
    retention.response_sample_budget_spent = mc.response_sample_budget_spent ();
    return retention;
}

RunSummaryInputs failed_run_summary_inputs (const RunContext& context) {
    const int64_t now = steady_now_ms ();
    RunSummaryInputs inputs;
    auto& mc               = *context.metrics_collector;
    inputs.total_requests  = mc.total_requests ();
    inputs.cancelled       = mc.cancelled ();
    const double elapsed_s = context.seconds_since_load_start (now);
    inputs.rps =
    elapsed_s > 0 ? static_cast<double> (inputs.total_requests) / elapsed_s : 0.0;
    inputs.throughput              = inputs.rps;
    inputs.test_duration_s         = elapsed_s;
    inputs.peak_concurrency        = context.peak_in_flight.load ();
    inputs.avg_in_flight           = mc.average_in_flight (elapsed_s, now);
    inputs.dropped_requests        = mc.dropped_requests ();
    inputs.skipped_requests        = mc.skipped_requests ();
    inputs.stalled_ms              = mc.stalled_ms ();
    inputs.queue_wait_avg_ms       = mc.average_queue_wait ();
    inputs.bytes_sent              = mc.total_bytes_sent ();
    inputs.bytes_received          = mc.total_bytes_received ();
    inputs.status_codes            = mc.status_code_distribution ();
    inputs.error_types             = mc.error_type_counts ();
    inputs.error_classes           = mc.error_class_counts ();
    inputs.latency                 = mc.calculate_percentiles ();
    inputs.latency_avg_ms          = mc.average_latency ();
    inputs.phases                  = mc.phase_percentiles ();
    inputs.phase_means             = mc.phase_means ();
    inputs.stream                  = mc.stream_totals ();
    inputs.retention               = read_retention (mc);
    inputs.slow_total              = mc.slow_total ();
    inputs.slow_threshold_ms       = context.slow_threshold_ms;
    inputs.http_version_downgraded = mc.http_version_downgraded ();
    inputs.connection_replays      = mc.connection_replays ();
    // No drain was timed apart here, so the window is the elapsed time.
    inputs.requests_sent           = context.requests_sent.load ();
    inputs.requests_expected       = context.requests_expected.load ();
    inputs.sending_duration_s      = elapsed_s;
    inputs.completed_while_sending = inputs.total_requests;
    inputs.send_rate =
    elapsed_s > 0 ? static_cast<double> (inputs.requests_sent) / elapsed_s : 0.0;
    inputs.auth = AuthRefreshState::summarize (context.auth_refresh_states);
    // No teardown runs on a failed run, so setup's rows are the whole node.
    inputs.lifecycle = vayu::core::build_lifecycle_node (context.setup_outcomes, {});
    return inputs;
}

/// The saved request a single-request load run was started from, as `pm.info`
/// names it to a script.
struct RunScriptIdentity {
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
};

/**
 * The identity a single-request run's scripts read as `pm.info.requestId` and
 * `pm.info.requestName`, inline or replayed: a load run's script is a Send's
 * script, so it must not read them as undefined here and a value there. Both
 * ride in on the composed payload for a run started from a saved request;
 * resolved once, not per sample. The linked row is read only for the
 * `pm.info.requestName` fallback, and a failure propagates, as the scopes' read
 * does (`validate_scripts`).
 */
RunScriptIdentity
read_run_script_identity (vayu::db::Database& db, const nlohmann::json& config) {
    RunScriptIdentity identity;
    if (auto id = config.find ("requestId");
    id != config.end () && id->is_string () && !id->get<std::string> ().empty ()) {
        identity.request_id = id->get<std::string> ();
    }
    if (auto name = config.find ("requestName"); name != config.end () &&
    name->is_string () && !name->get<std::string> ().empty ()) {
        identity.request_name = name->get<std::string> ();
        return identity;
    }
    if (!identity.request_id) {
        return identity;
    }
    if (auto linked_request = db.get_request (*identity.request_id);
    linked_request && !linked_request->name.empty ()) {
        identity.request_name = linked_request->name;
    }
    return identity;
}

/**
 * A step's un-inlined, enabled, non-blank `script.post` texts in compile order,
 * or none; the deferred replay reads the same `elements` list the sequential
 * runner does (#1514). Every such element is kept, as
 * `RunContext::compile_step_elements` does for a single-request run, so the
 * `deferred` tally and the replay count the same elements (#2167); each replays
 * as its own script (#3125).
 */
std::vector<std::string> find_step_post_scripts (const ScenarioStep& step,
RunContext::ScriptsOverrideMode scripts_mode) {
    std::vector<std::string> scripts;
    if (!step.elements) {
        return scripts;
    }
    for (const auto& element : *step.elements) {
        if (element.kind != "script.post" || !element.enabled) {
            continue;
        }
        // Already ran inline this run (issue #1495) - the pipeline hook
        // already reported its outcome, so there is nothing left to replay.
        if (RunContext::script_element_runs_inline (element.config, scripts_mode)) {
            continue;
        }
        if (auto found = element.config.find ("script");
        found != element.config.end () && found->is_string () &&
        !vayu::core::is_blank_script_text (found->get_ref<const std::string&> ())) {
            scripts.push_back (found->get<std::string> ());
        }
    }
    return scripts;
}

/// The virtual user and iteration a scenario load sample was sent as, which
/// its executor records on every sample (`submit_one`).
IterationIdentity scenario_sample_identity (const ResponseSample& sample) {
    return { vayu::utils::invariant_value (sample.vu, "a scenario load sample records its virtual user"),
        vayu::utils::invariant_value (
        sample.iteration, "a scenario load sample records its iteration") };
}

/**
 * The per-step replays of a scenario load run. A step with no script, or whose
 * script never got a sample, reports nothing rather than a row of zeros, as the
 * whole-run section does. Returns the steps' counts summed; each step's console
 * lines stay on its own `validation.steps` entry. @p state, null when the run's
 * driver never started, is what each sample's request is re-derived from.
 */
ScriptValidationTotals replay_scenario_steps (vayu::runtime::ScriptEngine& engine,
vayu::http::routes::RunVariableScopes& scopes,
const ScenarioLoadState* state,
const std::shared_ptr<RunContext>& context,
const vayu::http::SseLimits& sse_limits,
const vayu::runtime::ScriptSendInputs& send,
ScriptValidation& validation,
ReplayFailures& failures) {
    ScriptValidationTotals run_totals;
    const auto& plan      = context->scenario->plan;
    const auto& data_rows = context->scenario->data_rows;
    const size_t steps    = std::min (
    plan.steps.size (), context->metrics_collector->step_sample_step_count ());
    validation.steps.resize (steps);

    for (size_t i = 0; i < steps && !replay_stopped (send); ++i) {
        const auto& step = plan.steps[i];
        const auto& samples = context->metrics_collector->step_response_samples (i);
        const std::vector<std::string> post_scripts =
        find_step_post_scripts (step, context->scripts_override);
        // No script or no sample: no row, not a row of zeros (the docblock
        // above).
        if (post_scripts.empty () || samples.empty ()) {
            continue;
        }

        vayu::utils::log_debug ("run",
        "Validating response samples for step " + std::to_string (i + 1) +
        " (" + step.name + ")...",
        { { "runId", context->run_id }, { "sampleCount", samples.size () } });

        ScriptReplay replay;
        replay.scripts = &post_scripts;
        replay.cookie_read_refusal =
        "pm.cookies.%s is not available here: a replayed script runs after "
        "the run, against a recorded response; the user's cookies at that "
        "moment are not recorded. See docs/engine/scripting/cookies.md.";
        // The step's own request, so `pm.request` describes the step being
        // asserted on (a scenario payload has no run-level request), as each
        // sample sent it where the run's state can re-derive it (#3460).
        replay.request = &step.request;
        if (state != nullptr) {
            replay.request_as_sent = [&execution = *context->scenario,
                                     &bases      = state->scope_bases,
                                     i] (const ResponseSample& sample) {
                return step_request_as_submitted (execution, bases, i,
                sample.data_row_index, scenario_sample_identity (sample));
            };
        }
        replay.samples    = &samples;
        replay.data_rows  = data_rows.empty () ? nullptr : &data_rows;
        replay.request_id = step.request_id.empty () ?
        std::nullopt :
        std::optional<std::string> (step.request_id);
        replay.request_name =
        step.name.empty () ? std::nullopt : std::optional<std::string> (step.name);
        // Which step failed, in a message that may be read far from the
        // per-step tallies below.
        replay.failure_prefix =
        step.name.empty () ? "step " + std::to_string (i + 1) + ": " : step.name + ": ";
        replay.sse_limits = sse_limits;
        replay.send       = send;

        // The step's own folder, as the run read it (#3248).
        auto& step_scopes = scopes.bind (
        load_step_collection_id (step, context->scenario->request.collection_id));
        auto totals = run_replay (engine, step_scopes, replay, failures);
        // A Stop before the step's first sample: it judged nothing.
        if (totals.sampled == 0) {
            continue;
        }
        run_totals.sampled += totals.sampled;
        run_totals.passed += totals.passed;
        run_totals.failed += totals.failed;
        validation.steps[i] = std::move (totals);
    }

    return run_totals;
}

/// The failure summary this pass stores as a result row. `trace_data`:
/// `failures` (distinct messages, first-seen order, at most
/// MAX_FAILURE_MESSAGES), `failureCounts` (same length, occurrences of each),
/// `failuresDistinct` (every distinct message, so past the cap
/// `failuresDistinct - failures.size ()` were turned away), `totalFailed` and
/// `totalPassed` (assertion tallies, every occurrence counted).
void store_validation_failures (vayu::db::Database& db,
const std::string& run_id,
const ReplayFailures& failures,
size_t passed,
size_t failed) {
    if (failures.kept.empty ()) {
        return;
    }

    std::vector<size_t> counts;
    counts.reserve (failures.kept.size ());
    for (const auto& message : failures.kept) {
        counts.push_back (failures.occurrences.at (message));
    }

    nlohmann::json failure_json;
    failure_json["failures"]         = failures.kept;
    failure_json["failureCounts"]    = counts;
    failure_json["failuresDistinct"] = failures.distinct ();
    failure_json["totalFailed"]      = failed;
    failure_json["totalPassed"]      = passed;

    vayu::db::Result validation_result;
    validation_result.run_id    = run_id;
    validation_result.timestamp = now_ms ();
    validation_result.status_code = failed > 0 ? 0 : 200; // 0 indicates test failures
    validation_result.latency_ms = 0;
    validation_result.error = failed > 0 ? "Script validation failures" : "";
    validation_result.trace_data = failure_json.dump ();

    db.add_result (validation_result);
}

ScriptValidation validate_scripts (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const ReplayBase& base) {
    ScriptValidation validation;

    // Which shape this run is: a scenario load run's scripts hang off its plan
    // steps, a single-request run has one run-level script. The step stores
    // exist only where the executor sized them, so their presence is the test,
    // not a second flag that could disagree.
    const bool per_step = context->scenario != nullptr &&
    context->metrics_collector->step_sample_step_count () > 0;

    if (!per_step && context->test_scripts.empty ()) {
        return validation; // No script to validate
    }

    if (!per_step && context->metrics_collector->response_samples ().empty ()) {
        vayu::utils::log_debug ("run", "No response samples collected for script validation",
        { { "runId", context->run_id } });
        return validation;
    }

    // Create script engine for validation, bounded by the same timeout/limits
    // the execute path reads so an infinite-loop test script cannot spin the
    // run's worker thread forever.
    vayu::runtime::ScriptConfig script_config = vayu::core::read_script_config (db);
    // Through the reader `POST /execute` uses: this `tests` script is a Send's
    // script, so `pm.sendRequest` must not exist in one and not the other. It
    // runs once per *sampled* response, which the per-script request cap
    // bounds.
    script_config.allow_send_request =
    vayu::http::read_allow_script_requests (context->config);

    vayu::runtime::ScriptEngine engine (script_config);
    // One read for the whole pass, shared by every replay it drives.
    const vayu::http::SseLimits sse_limits = vayu::http::read_sse_limits (db);
    // What these scripts' `pm.sendRequest` inherits. Route and default headers
    // are the run's snapshot (`RunContext::script_send`, #1256, #2841): what
    // the asserted traffic took; a script reaching the target another way (a
    // proxy edited mid-run, a client certificate registered since) would report
    // a healthy target broken. The bound (#1188, the load one, as this is the
    // load path) and the timeout (#2833) are what this pass may read *now*, so
    // they are re-read.
    vayu::runtime::ScriptSendInputs script_send = context->script_send;
    script_send.max_response_bytes = vayu::http::routes::load_response_body_bound (db);
    script_send.request_timeout_ms =
    vayu::http::routes::resolve_request_timeout_ms (context->config, db);

    // The run-level request and identity, for the single-request shape. A
    // scenario takes both off the plan step it is replaying instead, so it does
    // not pay for a payload lookup whose answer it would discard.
    vayu::Request dummy_request;
    RunScriptIdentity script_identity;
    if (!per_step) {
        // HTTP request fields are at the root of the run's payload.
        if (auto request_result = vayu::json::deserialize_request (context->config);
        request_result.is_ok ()) {
            dummy_request = request_result.value ();
        }
        script_identity = read_run_script_identity (db, context->config);
    }

    // The scopes the replayed scripts read (#728): a load run's `tests` script
    // is a Send's, so `pm.environment.get('region')` must answer the same, or a
    // test comparing a response with a variable fails every sample and reports
    // the target broken.
    //
    // The collection scope is the one the sequential paths use: a scenario
    // step's own folder chain (#3248); a single-request run's linked request's
    // collection, else the payload's composed `collectionId`
    // (`single_request_lifecycle_collection_id`, #3461). Read off the payload,
    // which the run row was populated from.
    //
    // A database failure is deliberately not caught: it propagates to
    // `execute_load_test`, which logs it and stores no `testValidation`
    // section. Tallies against scopes that failed to load would be silently
    // wrong verdicts, and "never judged" must not read as "judged and passed".
    const auto environment_id = named_id (context->config, "environmentId");

    // Copied from what setup left (#3460), so a deferred script reads setup's
    // writes as an inline one does; a copy, because teardown reads the original
    // after this pass. Only a context with no worker behind it (`ReplayBase`
    // empty) loads the stored rows. One set for every replay of the pass, so a
    // `set()` is visible to later samples, as within a sequential run. Never
    // persisted: `persist_script_variables` is design-mode only, and a
    // reservoir sample is not an iteration, so storing the last replay's value
    // would store one no ordering justifies.
    ScriptValidationTotals totals;
    ReplayFailures failures;

    if (per_step) {
        auto scopes = base.scenario_state != nullptr ?
        base.scenario_state->lifecycle_scopes :
        scenario_load_scopes (db, environment_id, *context->scenario);
        totals = replay_scenario_steps (engine, scopes, base.scenario_state,
        context, sse_limits, script_send, validation, failures);
        // Every scripted step drew a blank, so the run validated nothing.
        if (totals.sampled == 0) {
            return validation;
        }
    } else {
        const auto& samples = context->metrics_collector->response_samples ();
        vayu::utils::log_debug ("run", "Validating response samples with test script...",
        { { "runId", context->run_id }, { "sampleCount", samples.size () } });

        ScriptReplay replay;
        replay.scripts = &context->test_scripts;
        replay.request = &dummy_request;
        if (base.shared_request != nullptr) {
            replay.request_as_sent = [&run = *context, &shared = *base.shared_request] (
                                     const ResponseSample& sample) {
                const ResultAnnotations annotations{ sample.data_row_index,
                    std::nullopt, sample.iteration, sample.vu };
                return request_as_submitted (run, shared, annotations);
            };
        }
        replay.samples = &samples;
        replay.cookie_read_refusal =
        "pm.cookies.%s is not available here: a single-request load run "
        "has no scenario and so no per-user cookie state to read. Use "
        "pm.response.cookies for the Set-Cookie of the response in hand. "
        "See docs/engine/scripting/cookies.md.";
        // The run's bound rows, so a sampled submission reads the row it
        // carried as `pm.iterationData`, by the row index the sample was
        // stamped with (#993), as a scenario step's replay does. Null for a run
        // without rows, which keeps `pm.iterationData` `undefined`.
        replay.data_rows =
        context->load_data == nullptr ? nullptr : &context->load_data->rows;
        replay.request_id   = script_identity.request_id;
        replay.request_name = script_identity.request_name;
        replay.sse_limits   = sse_limits;
        replay.send         = script_send;

        auto scopes = base.request_scopes != nullptr ?
        *base.request_scopes :
        vayu::http::routes::load_script_variable_scopes (db, environment_id,
        single_request_lifecycle_collection_id (db, context->config));
        totals      = run_replay (engine, scopes, replay, failures);
        // A Stop before the first sample: never judged, not judged and passed.
        if (totals.sampled == 0) {
            return validation;
        }
    }

    store_validation_failures (
    db, context->run_id, failures, totals.passed, totals.failed);

    vayu::utils::log_debug ("run", "Script validation",
    { { "runId", context->run_id }, { "passed", totals.passed },
    { "failed", totals.failed } });

    validation.run = std::move (totals);
    return validation;
}

SampledValidationTotals validate_sampled_responses (
const std::shared_ptr<RunContext>& context) {
    SampledValidationTotals totals;

    // Scenario load runs only: a single-request load run resolves no
    // collection, so no binding (and reports no coverage); the per-step stores
    // identify a scenario run, as in the script pass.
    if (context->scenario == nullptr ||
    context->metrics_collector->step_sample_step_count () == 0) {
        return totals;
    }

    const auto& spec = context->scenario->spec;
    if (spec.response_schemas.empty ()) {
        return totals;
    }

    // The run's one parse of the schema index, after the last completion
    // landed. An index that will not parse is "not measured", as every other
    // reader of a stored index treats it, never an empty contract that passes
    // every body.
    const auto index = ResponseSchemaIndex::parse (spec.response_schemas);
    if (!index) {
        return totals;
    }

    const auto& plan   = context->scenario->plan;
    const size_t steps = std::min (
    plan.steps.size (), context->metrics_collector->step_sample_step_count ());

    for (size_t i = 0; i < steps; ++i) {
        const auto& step = plan.steps[i];
        // A step bound to no operation is outside this contract: counting it
        // unchecked would fill the block with `no_operation` for every unbound
        // step of a mixed collection.
        if (step.spec_operation.empty ()) {
            continue;
        }

        const auto& samples = context->metrics_collector->step_response_samples (i);
        for (const auto& sample : samples) {
            const auto content_type = sample.headers.find ("Content-Type");
            try {
                totals.record (
                index->check (step.spec_operation, sample.status_code,
                content_type != sample.headers.end () ? content_type->second : std::string (),
                sample.body),
                step.name, sample.status_code);
            } catch (const std::exception& e) {
                // A validator that threw is not a response that failed, and it
                // must not cost the run the rest of its samples. Same rule the
                // design-mode hook applies to the same call.
                vayu::utils::log_warning ("run",
                "Schema validation of a sample failed: " + std::string (e.what ()),
                { { "runId", context->run_id } });
            }
        }
    }

    if (totals.sampled > 0) {
        vayu::utils::log_debug ("run", "Schema validation",
        { { "runId", context->run_id }, { "checked", totals.checked },
        { "sampled", totals.sampled }, { "valid", totals.valid },
        { "failed", totals.failed } });
    }
    return totals;
}

namespace {

/// The stored `tests` object, the run's and a scenario step's alike:
/// `{sampled, passed, failed, console?, consoleDropped?}`.
nlohmann::json test_totals_payload (const ScriptValidationTotals& tests) {
    nlohmann::json payload = { { "sampled", tests.sampled },
        { "passed", tests.passed }, { "failed", tests.failed } };
    write_message_sample (
    payload, "console", "consoleDropped", tests.console, tests.console_dropped);
    return payload;
}

} // namespace

void attach_step_test_totals (nlohmann::json& scenario,
const std::vector<std::optional<ScriptValidationTotals>>& per_step) {
    auto steps = scenario.find ("steps");
    if (steps == scenario.end () || !steps->is_array ()) {
        return;
    }
    const size_t count = std::min (steps->size (), per_step.size ());
    for (size_t i = 0; i < count; ++i) {
        const auto& tests = per_step[i];
        if (!tests) {
            continue;
        }
        (*steps)[i]["tests"] = test_totals_payload (*tests);
    }
}

namespace {

/// Whether a collection load plan has a step that streams (#3304).
bool plan_streams (const std::shared_ptr<const ScenarioExecution>& scenario) {
    return scenario != nullptr && longest_stream_bounds (scenario->plan).has_value ();
}

/// A single-request run's stream bounds: its caps over @p defaults, plus
/// `streamTextPath` (#3773) and `streamFirstContentMarker` (#3774), each
/// compiled once for every transfer. Nothing when the run does not stream.
/// `read_stream_flag` checked them all in the route, so a value here is usable.
std::optional<vayu::StreamBounds> single_request_stream_bounds (const nlohmann::json& config,
const vayu::http::SseLimits& defaults) {
    if (!config.value ("stream", false)) {
        return std::nullopt;
    }
    auto bounds = vayu::http::resolve_stream_bounds (
    config, vayu::http::default_stream_bounds (defaults));
    if (const auto path = config.find ("streamTextPath");
    path != config.end () && path->is_string ()) {
        bounds.text_path =
        vayu::http::compile_stream_text_path (path->get_ref<const std::string&> ());
    }
    if (const auto marker = config.find ("streamFirstContentMarker");
    marker != config.end () && marker->is_string ()) {
        bounds.first_content_marker = vayu::http::compile_stream_content_marker (
        marker->get_ref<const std::string&> ());
    }
    return bounds;
}

} // namespace

RunContext::RunContext (const std::string& id,
nlohmann::json cfg,
size_t max_errors,
const EngineDefaults& engine_defaults,
std::shared_ptr<const ScenarioExecution> load_scenario)
: run_id (id),
  config (cfg.is_object () ? std::move (cfg) : nlohmann::json::object ()),
  scenario (std::move (load_scenario)) {
    // Initialize MetricsCollector with configuration from test config
    MetricsCollectorConfig mc_config;
    mc_config.max_errors = max_errors;

    mc_config.expected_requests = expected_requests_for (config);

    // Get sampling config
    mc_config.success_sample_rate =
    static_cast<size_t> (config.value ("success_sample_rate", 100));
    mc_config.store_success_traces = config.value ("save_timing_breakdown", false);
    mc_config.max_success_results =
    static_cast<size_t> (config.value ("max_success_results",
    static_cast<int64_t> (constants::metrics_collector::DEFAULT_MAX_SUCCESS_RESULTS)));
    mc_config.max_slow_results =
    static_cast<size_t> (config.value ("max_slow_results",
    static_cast<int64_t> (constants::metrics_collector::DEFAULT_MAX_SLOW_RESULTS)));

    // Outlier capture threshold, read once here rather than per completion.
    slow_threshold_ms = config.value ("slow_threshold_ms",
    constants::metrics_collector::DEFAULT_SLOW_THRESHOLD_MS);

    // Response capture for the retained samples, on by default because the
    // policy is failure-and-outlier-shaped, not uniform: a healthy run captures
    // a handful of exemplars. The per-body cap and whole-run budget default
    // from engine config (both `data_retention` keys) and can be overridden per
    // run, as the retention caps can.
    mc_config.capture_response_bodies = config.value ("capture_response_bodies",
    constants::metrics_collector::DEFAULT_CAPTURE_RESPONSE_BODIES);
    mc_config.max_sample_body_bytes =
    static_cast<size_t> (config.value ("max_sample_body_bytes",
    static_cast<int64_t> (engine_defaults.max_sample_body_bytes)));
    mc_config.max_sample_bytes = static_cast<size_t> (config.value (
    "max_sample_bytes", static_cast<int64_t> (engine_defaults.max_sample_bytes)));
    // Per-phase histograms. Engine-config default, per-run override like the
    // caps above - a run that only wants the cheapest possible completion path
    // can switch them off without changing the setting for every other run.
    mc_config.phase_histograms =
    config.value ("phase_histograms", engine_defaults.phase_histograms);
    // The event histogram behind the report's `stream` section. Run-config
    // only, with no engine-wide setting as `phaseHistograms` has: that one
    // switches off a cost *every* run pays, and this is paid only by a run that
    // opted into streaming (#576).
    mc_config.stream_metrics = config.value (
    "stream_metrics", constants::metrics_collector::DEFAULT_STREAM_METRICS);

    // The caps a streaming run's transfers are bounded by. A collection run
    // never carries `stream` (the route refuses it there): each streaming step
    // took its caps and its text path from the plan (#3235, #3773).
    stream_bounds = single_request_stream_bounds (config, engine_defaults.sse_limits);
    mc_config.streams = stream_bounds.has_value () || plan_streams (scenario);
    mc_config.max_exemplar_results =
    static_cast<size_t> (config.value ("max_exemplar_results",
    static_cast<int64_t> (constants::metrics_collector::DEFAULT_MAX_EXEMPLAR_RESULTS)));
    capture_response_bodies = mc_config.capture_response_bodies;
    max_element_body_bytes  = engine_defaults.max_element_body_bytes;
    sse_limits              = engine_defaults.sse_limits;

    // Bounded twice: by count here and by bytes in the budget below, since a
    // retained sample holds a whole body and the count alone bounds memory only
    // for small bodies (#1155).
    mc_config.max_response_samples =
    static_cast<size_t> (config.value ("max_response_samples", 1000));
    mc_config.max_response_sample_bytes =
    static_cast<size_t> (config.value ("max_response_sample_bytes",
    static_cast<int64_t> (engine_defaults.max_response_sample_bytes)));
    mc_config.response_sample_rate =
    static_cast<size_t> (config.value ("response_sample_rate", 100));

    // `validate_elements_run_override` accepted this payload before the run row
    // existed, so an unknown value here falls back to the default rather than
    // throwing: there is no rejection left to make.
    if (auto elements = config.find ("elements");
    elements != config.end () && elements->is_object ()) {
        const std::string scripts = elements->value ("scripts", std::string{});
        if (scripts == "allInline") {
            scripts_override = ScriptsOverrideMode::AllInline;
        } else if (scripts == "allDeferred") {
            scripts_override = ScriptsOverrideMode::AllDeferred;
        }
        include_script_time = elements->value ("includeScriptTime", false);

        // "asConfigured" | "off" | {fixedMs} | {minMs,maxMs} (the object shapes
        // are #1498's); any other shape falls back to the default, by the rule
        // above.
        if (auto timers = elements->find ("timers"); timers != elements->end ()) {
            if (timers->is_string () && *timers == "off") {
                timers_override.mode = vayu::core::TimersOverride::Mode::Off;
            } else if (timers->is_object () && timers->contains ("fixedMs")) {
                timers_override.mode = vayu::core::TimersOverride::Mode::Fixed;
                timers_override.fixed_ms = timers->value ("fixedMs", int64_t{ 0 });
            } else if (timers->is_object () &&
            (timers->contains ("minMs") || timers->contains ("maxMs"))) {
                timers_override.mode = vayu::core::TimersOverride::Mode::Range;
                timers_override.min_ms = timers->value ("minMs", int64_t{ 0 });
                timers_override.max_ms = timers->value ("maxMs", timers_override.min_ms);
            }
        }

        // A run without an explicit seed still gets a real one (the member
        // initialiser draws from `std::random_device`); only a caller wanting
        // *this* run reproducible supplies one. `rng_seed` and `rng` are
        // re-seeded together: a scenario load run derives its virtual users'
        // generators from `rng_seed` alone, so the two must never disagree
        // about the seed used.
        if (auto seed = elements->find ("seed"); seed != elements->end () &&
        seed->is_number_integer () && seed->get<int64_t> () >= 0) {
            rng_seed = static_cast<uint64_t> (seed->get<int64_t> ());
            rng.seed (rng_seed);
        }
    }

    // A single-request run's own step-level elements (issue #1594) - after
    // `scripts_override` above, since a `script.post` element's
    // inline-or-deferred fate can depend on it.
    compile_step_elements (config);
    // `validate_run_config` refused a wrong type or a cap outside its range
    // before the run row existed.
    retry_after_backoff = config.value ("retryAfterBackoff", false);
    retry_after_max_ms  = config.value (
    "retryAfterMaxMs", constants::run_config::DEFAULT_RETRY_AFTER_MAX_MS);

    // The route refused a malformed policy before this run existed, so a
    // reading that fails here means a caller skipped that check: no host is
    // allowed rather than every one.
    if (auto policy = vayu::http::read_target_policy (config)) {
        target_policy = std::move (*policy);
    } else {
        target_policy = vayu::http::TargetPolicy{};
    }

    metrics_collector = std::make_unique<MetricsCollector> (id, mc_config);
    // Every transfer carries the run's live counters on its bounds, so its
    // tally can count into them without knowing about the collector.
    if (stream_bounds) {
        stream_bounds->live = metrics_collector->live_stream_counts ();
    }
}

int64_t RunContext::honour_retry_after (const vayu::Response& response) const {
    if (!retry_after_backoff || !closed_loop.load (std::memory_order_relaxed)) {
        return 0;
    }
    if (response.status_code != 429 && response.status_code != 503) {
        return 0;
    }
    const auto header = response.headers.find ("Retry-After");
    if (header == response.headers.end ()) {
        return 0;
    }
    const auto delay = vayu::http::retry_after_delay_ms (
    header->second, std::chrono::system_clock::now ());
    if (!delay || *delay <= 0) {
        return 0;
    }
    metrics_collector->record_retry_after_wait ();
    return std::min (*delay, retry_after_max_ms);
}

/**
 * Compiles `requestElements` (#1594) once into @ref step_elements; the route
 * refuses them beside a `scenario` block, so this is a no-op for that shape.
 * Each `script.post` here not running inline has its text appended to
 * @ref test_scripts in compile order, for the deferred replay
 * (`validate_scripts`) to run one by one (#3125). An inline one is the pipeline
 * hooks' (`submit_one_request` / `run_request_elements_after_submission`,
 * `load_strategy.cpp`), and the replay must not run it again. Split out of the
 * constructor for its cognitive complexity; nothing else calls it.
 */
void RunContext::compile_step_elements (const nlohmann::json& run_config) {
    if (!declares_request_elements (run_config)) {
        return;
    }
    nlohmann::json stamped = run_config.at ("requestElements");
    vayu::core::stamp_default_element_ids (stamped);
    auto compiled = std::make_shared<std::vector<vayu::core::CompiledElement>> (
    vayu::core::compile_elements (stamped));
    for (const auto& element : *compiled) {
        const auto* kind = vayu::core::Registry::instance ().find (element.kind);
        if (kind != nullptr &&
        std::find (kind->phases.begin (), kind->phases.end (),
        vayu::core::Phase::StepBefore) != kind->phases.end ()) {
            step_elements_have_step_before = true;
        }
        if (element.kind != "script.post" || !element.enabled ||
        RunContext::script_element_runs_inline (element.config, scripts_override)) {
            continue;
        }
        // Every un-inlined `script.post` is kept, not only the first: a saved
        // request composes the collection chain's elements before its own
        // (#1514's `compose_elements` order), and both defer by default. A
        // blank one is left out: replayed alone it would tally a pass per
        // sample for a script asserting nothing.
        if (auto script = element.config.find ("script");
        script != element.config.end () && script->is_string () &&
        !vayu::core::is_blank_script_text (script->get_ref<const std::string&> ())) {
            test_scripts.push_back (script->get<std::string> ());
        }
    }
    element_tallies = vayu::core::RequestElementTallies (*compiled);
    step_elements   = std::move (compiled);
}

RunContext::~RunContext () {
    request_stop ();
    // The worker joins these itself before returning; this covers a context
    // destroyed before its worker ran. The *worker* thread is RunManager's
    // (`run_workers_`), never the context's; the declaration says why.
    join_aux_threads ();
}

void RunContext::request_stop () {
    const RunPhase observed = phase_latch_.latch_stop ();
    should_stop.store (true);
    // Wakes the closed-loop controller so it sees should_stop without waiting
    // out its `CONTROLLER_TICK_MS` safety-net timeout.
    notify_refill ();
    // Before the drain the strategy is still submitting, and a cancelled loop
    // consumes nothing, so its producer would block on a full queue.
    if (observed < RunPhase::draining) {
        return;
    }
    std::lock_guard<std::mutex> lock (event_loop_mtx);
    if (event_loop) {
        event_loop->cancel ();
    }
}

void RunContext::join_aux_threads () {
    aux_cancel.store (true, std::memory_order_release);
    if (metrics_thread.joinable ()) {
        metrics_thread.join ();
    }
    // Same reasoning for the scrape loop: a joinable thread left on a
    // destroyed context is std::terminate, not a leak.
    if (monitor_thread.joinable ()) {
        monitor_thread.join ();
    }
    for (auto& thread : auth_refresh_threads) {
        if (thread.joinable ()) {
            thread.join ();
        }
    }
}

double RunContext::seconds_since_load_start (int64_t now_steady_ms) const {
    const int64_t start = load_start_steady_ms.load ();
    if (start == 0) {
        return 0.0;
    }
    // A tick can take its clock reading just before the worker stamps the
    // start and read the stamp just after, which would be a few ms negative.
    return static_cast<double> (std::max<int64_t> (now_steady_ms - start, 0)) / 1000.0;
}

void RunManager::register_run (const std::string& run_id, std::shared_ptr<RunContext> context) {
    std::lock_guard<std::mutex> lock (mutex_);
    active_runs_[run_id] = std::move (context);
}

std::shared_ptr<RunContext> RunManager::get_run (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = active_runs_.find (run_id);
    if (it != active_runs_.end ()) {
        return it->second;
    }
    return nullptr;
}

void RunManager::unregister_run (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    active_runs_.erase (run_id);
}

void RunManager::retain_run (const std::string& run_id) {
    std::shared_ptr<RunContext> retained;
    {
        std::lock_guard<std::mutex> lock (mutex_);
        auto it = active_runs_.find (run_id);
        if (it == active_runs_.end ())
            return;
        it->second->completed_at_ms.store (now_ms ());
        it->second->advance_phase (RunPhase::settled);
        it->second->settled.store (true, std::memory_order_release);
        retained               = it->second;
        retained_runs_[run_id] = it->second;
        active_runs_.erase (it);
    }
    // Retention keeps the tick topic, not the machinery: a finished run held
    // its curl handle pools, cached target connections, submission queues and
    // bound rows for the whole window (#1154). Freed after the map move with
    // `mutex_` dropped, because closing thousands of sockets under it would
    // stall /health, the runs poll and a starting run for the whole teardown.
    retained->release_execution_resources ();
}

std::shared_ptr<RunContext> RunManager::get_run_or_retained (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto a = active_runs_.find (run_id);
    if (a != active_runs_.end ())
        return a->second;
    auto r = retained_runs_.find (run_id);
    if (r != retained_runs_.end ())
        return r->second;
    return nullptr;
}

void RunManager::sweep_retained (int64_t ttl_ms) {
    std::lock_guard<std::mutex> lock (mutex_);
    int64_t cutoff = now_ms () - ttl_ms;
    for (auto it = retained_runs_.begin (); it != retained_runs_.end ();) {
        if (it->second->completed_at_ms.load () < cutoff) {
            it = retained_runs_.erase (it);
        } else {
            ++it;
        }
    }
}

size_t RunManager::active_count () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return active_runs_.size ();
}

size_t RunManager::retained_count () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return retained_runs_.size ();
}

void RunManager::start_sweeper (std::function<int64_t ()> ttl_provider) {
    {
        std::lock_guard<std::mutex> lock (sweeper_mtx_);
        if (sweeper_thread_.joinable ())
            return; // already running
        sweeper_stop_         = false;
        sweeper_ttl_provider_ = std::move (ttl_provider);
    }
    sweeper_thread_ = std::thread ([this] () {
        std::unique_lock<std::mutex> lock (sweeper_mtx_);
        while (!sweeper_stop_) {
            // The TTL is re-read each tick, so changing liveRetentionMs
            // (Settings → Observability) needs no daemon restart. Sweeping at
            // half the TTL evicts a retained run within ttl..1.5*ttl of
            // completion; the 500ms cadence floor keeps a tiny or zero TTL
            // (retention disabled) from busy-looping. ttl==0 means "evict
            // immediately", which sweep_retained handles.
            //
            // The provider reads the DB (the daemon wires it to
            // get_config_int), so it can throw; uncaught in the sweeper thread
            // that is std::terminate, taking the daemon down over a
            // housekeeping tick. A tick whose TTL could not be read is skipped,
            // not swept against a guessed TTL that would evict retained runs
            // early.
            int64_t ttl   = 0;
            bool have_ttl = true;
            try {
                ttl = std::max<int64_t> (sweeper_ttl_provider_ (), 0);
            } catch (...) {
                have_ttl = false;
            }
            auto interval = std::chrono::milliseconds (
            have_ttl ? std::max<int64_t> (ttl / 2, 500) : 500);
            if (sweeper_cv_.wait_for (
                lock, interval, [this] { return sweeper_stop_; })) {
                break;
            }
            lock.unlock ();
            if (have_ttl) {
                try {
                    sweep_retained (ttl);
                } catch (...) {
                    // @deliberate: never let an exception escape the sweeper
                    // thread - it runs with no catch above it, so anything that
                    // got out would take the process down over a retention
                    // sweep. The next tick sweeps again.
                }
            }
            lock.lock ();
        }
    });
}

void RunManager::start_sweeper (int64_t ttl_ms) {
    start_sweeper ([ttl_ms] () { return ttl_ms; });
}

void RunManager::stop_sweeper () {
    {
        std::lock_guard<std::mutex> lock (sweeper_mtx_);
        sweeper_stop_ = true;
    }
    sweeper_cv_.notify_all ();
    if (sweeper_thread_.joinable ()) {
        sweeper_thread_.join ();
    }
}

RunManager::~RunManager () {
    // A destructor must not throw; shutdown() only logs and joins, but the
    // logger and the joins are the parts a broken invariant would surface in.
    try {
        shutdown ();
    } catch (...) {
        // @deliberate: a destructor must not throw, and there is no one left to
        // report to - the manager is going away with the daemon.
    }
    stop_sweeper ();
}

size_t RunManager::tracked_worker_count () const {
    std::lock_guard<std::mutex> lock (workers_mtx_);
    return run_workers_.size ();
}

std::vector<std::thread> RunManager::take_finished_workers () {
    // `mutex_` answers "is this run still active"; `workers_mtx_` owns the
    // handle. Whenever both are held the order is workers_mtx_ -> mutex_,
    // which is what lets start_run hold the former across register_run.
    std::vector<std::thread> finished;
    std::lock_guard<std::mutex> runs_lock (mutex_);
    for (auto it = run_workers_.begin (); it != run_workers_.end ();) {
        if (active_runs_.find (it->first) == active_runs_.end ()) {
            finished.push_back (std::move (it->second));
            it = run_workers_.erase (it);
        } else {
            ++it;
        }
    }
    return finished;
}

void RunManager::shutdown (std::chrono::milliseconds grace) {
    {
        std::lock_guard<std::mutex> lock (workers_mtx_);
        shutting_down_ = true;
    }

    // Signal first, then wait: every worker gets its stop request before any
    // of them is waited on, so the grace period is shared rather than serial.
    auto active = get_all_active_runs ();
    for (const auto& context : active) {
        context->request_shutdown ();
    }

    if (!active.empty ()) {
        vayu::utils::log_info ("run",
        "Stopping " + std::to_string (active.size ()) + " active load test(s)...");
        auto deadline = std::chrono::steady_clock::now () + grace;
        while (active_count () > 0 && std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        if (size_t remaining = active_count (); remaining > 0) {
            vayu::utils::log_warning ("run",
            std::to_string (remaining) + " load test(s) had not settled after " +
            std::to_string (grace.count ()) +
            "ms; waiting for them anyway - abandoning a worker would leave it "
            "writing to a destroyed database");
        }
    }

    std::vector<std::thread> workers;
    {
        std::lock_guard<std::mutex> lock (workers_mtx_);
        for (auto& entry : run_workers_) {
            workers.push_back (std::move (entry.second));
        }
        run_workers_.clear ();
    }
    // Joined outside every lock: a worker's last act is retain_run, which takes
    // `mutex_`, so joining while holding it would deadlock the drain.
    for (auto& thread : workers) {
        if (thread.joinable ())
            thread.join ();
    }

    if (!active.empty ()) {
        vayu::utils::log_info ("run", "All load tests stopped");
    }
}

std::vector<std::shared_ptr<RunContext>> RunManager::get_all_active_runs () const {
    std::lock_guard<std::mutex> lock (mutex_);
    std::vector<std::shared_ptr<RunContext>> runs;
    runs.reserve (active_runs_.size ());
    for (const auto& [id, context] : active_runs_) {
        runs.push_back (context);
    }
    return runs;
}

bool RunManager::spawn_run (const std::string& run_id,
const nlohmann::json& config,
vayu::db::Database& db,
std::shared_ptr<const ScenarioExecution> load_scenario,
const std::function<std::thread (const std::shared_ptr<RunContext>&)>& spawn) {
    // See the declaration for why `workers_mtx_` is held across the whole
    // block rather than just the insert.
    std::vector<std::thread> finished;
    {
        std::lock_guard<std::mutex> workers_lock (workers_mtx_);
        if (shutting_down_) {
            vayu::utils::log_warning ("run",
            "Refusing to start run: engine is shutting down", { { "runId", run_id } });
            return false;
        }

        // Reap the handles of runs that have already finished, so a long-lived
        // daemon does not accumulate one per run. Done here rather than by the
        // workers themselves because a thread cannot join itself.
        finished = take_finished_workers ();

        // The config-backed defaults RunContext cannot read itself (it holds no
        // Database), resolved here as `maxStoredErrors` is; a run's own config
        // still overrides each.
        EngineDefaults engine_defaults;
        engine_defaults.max_sample_body_bytes =
        static_cast<size_t> (db.get_config_int ("maxSampleBodyBytes",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES)));
        engine_defaults.max_element_body_bytes =
        static_cast<size_t> (db.get_config_int ("maxElementBodyBytes",
        static_cast<int> (vayu::core::constants::elements::MAX_BODY_BYTES)));
        engine_defaults.phase_histograms =
        db.get_config_bool ("phaseHistograms",
        vayu::core::constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS);
        engine_defaults.max_sample_bytes =
        static_cast<size_t> (db.get_config_int ("maxSampleBytes",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES)));
        engine_defaults.max_response_sample_bytes =
        static_cast<size_t> (db.get_config_int ("maxResponseSampleBytes",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_RESPONSE_SAMPLE_BYTES)));
        // The same settings the design path's stream reads, so a user who
        // tightened them once has tightened them for both (issue #576).
        engine_defaults.sse_limits = vayu::http::read_sse_limits (db);

        auto context = std::make_shared<RunContext> (run_id, config,
        static_cast<size_t> (db.get_config_int ("maxStoredErrors",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS))),
        engine_defaults, std::move (load_scenario));
        register_run (run_id, context);

        // Sweep stale retained runs on each new registration so that headless /
        // API-only usage (which never hits /runs/:id/live) doesn't accumulate them.
        int retention_ms = db.get_config_int ("liveRetentionMs", 60000);
        sweep_retained (retention_ms);

        // IMPORTANT: Set is_running BEFORE spawning threads to avoid race condition
        // where metrics_thread exits immediately because is_running is still false
        context->is_running = true;

        // The handle is kept - not detached - so shutdown can join the worker
        // before `db` and this manager go out of scope from under the
        // references it captures.
        run_workers_[run_id] = spawn (context);
    }

    // Outside the lock: these threads are past retain_run and only unwinding,
    // so the join is a formality - but it is still a join, and the discipline
    // is that no lock is held across one.
    for (auto& thread : finished) {
        if (thread.joinable ())
            thread.join ();
    }
    return true;
}

bool RunManager::start_run (const std::string& run_id,
const nlohmann::json& config,
vayu::db::Database& db,
std::shared_ptr<const ScenarioExecution> scenario,
std::unique_ptr<LoadDataSet> data,
LoadAuthPlan auth_plan,
std::shared_ptr<vayu::http::FilePlan> files) {
    return spawn_run (run_id, config, db, std::move (scenario),
    [&] (const std::shared_ptr<RunContext>& context) {
        // Set before either thread starts: the worker splits this set's request
        // template before its first submission and every strategy reads it
        // after, so a later write would race the run it shapes.
        context->load_data = std::move (data);
        // And the credential plan beside it, which `build_load_request` reads
        // to decide whether the build resolves this run's auth at all.
        context->load_auth = std::move (auth_plan);
        // And the files the route already checked, which the build fills from.
        context->file_plan = std::move (files);
        // Spawn metrics collection thread first - it is NOT detached and is
        // joined by the worker thread below.
        context->metrics_thread =
        std::thread ([context, &db] () { collect_metrics (context, &db); });
        // Server vitals, when this run asked for them, from the config the
        // route validated. Nothing from `monitor_config_from` means the run
        // declared no monitor (or a snapshot this engine cannot read), and the
        // run proceeds without one. The totals live on the context so the
        // summary can read them once this thread is joined.
        if (auto monitor =
            monitor_config_from (context->config, read_monitor_limits (db))) {
            context->monitor_totals = std::make_unique<MonitorTotals> ();
            context->monitor_thread =
            std::thread ([context, &db, cfg = std::move (*monitor)] () mutable {
                collect_monitor (context, &db, cfg);
            });
        }
        return std::thread (
        [context, &db, this] () { execute_load_test (context, &db, *this); });
    });
}

bool RunManager::start_scenario_run (const std::string& run_id,
const nlohmann::json& config,
std::shared_ptr<const ScenarioExecution> execution,
vayu::db::Database& db,
vayu::http::CookieJar& cookie_jar) {
    // A design run's plan travels to its runner, never onto the context: its
    // steps take the sequential path, which keeps no live ticks.
    return spawn_run (run_id, config, db, nullptr,
    [&, execution = std::move (execution)] (const std::shared_ptr<RunContext>& context) {
        return std::thread ([context, execution, &db, &cookie_jar, this] () {
            execute_scenario_run (context, execution, &db, &cookie_jar, *this);
        });
    });
}

/**
 * The event loop this run drives, configured, started and published. Published
 * last: the metrics thread has been ticking since before this thread ran
 * (`start_run` spawns both, metrics first) and reads the loop through
 * `active_transfer_count()`, so the pointer lands under the same lock (#956),
 * and only once the loop is started, so no reader sees it half-built.
 */
void configure_event_loop (vayu::db::Database& db,
const nlohmann::json& config,
const std::shared_ptr<RunContext>& context,
size_t concurrency,
int timeout_ms,
int configured_workers,
int default_max_per_host) {
    vayu::http::EventLoopConfig loop_config;
    loop_config.num_workers = static_cast<size_t> (configured_workers); // Already resolved (see resolve_worker_count)
    loop_config.max_concurrent = std::max (concurrency, size_t{ 100 });
    const auto configured_per_host =
    static_cast<size_t> (std::max (default_max_per_host, 1));
    loop_config.max_per_host = effective_max_per_host (configured_per_host,
    concurrency, static_cast<size_t> (std::max (configured_workers, 0)));
    context->configured_max_per_host = configured_per_host;
    context->effective_max_per_host  = loop_config.max_per_host;
    vayu::utils::log_info ("run", "Per-host connection limit",
    { { "runId", context->run_id }, { "configured", configured_per_host },
    { "effective", loop_config.max_per_host },
    { "workers", configured_workers }, { "concurrency", concurrency } });
    // `target_rps` stays 0 on every run: a `constant_rps` run is paced by its
    // pacing thread alone, and a worker-side bucket on top drifts against that
    // schedule and counts the wait as latency (#2801). On other modes a bucket
    // throttles a closed-loop run (#2396).
    loop_config.dns_cache_timeout = db.get_config_int ("dnsCacheTimeout",
    vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS);
    // Read once and held for the run; EventLoopConfig::transport says why a
    // per-request policy would cost the connection pool. The client-certificate
    // registry (#707) rides inside, so load runs resolve certificates at run
    // start: libcurl reuses a pooled connection only when its TLS identity
    // matches, so a certificate changing mid-run would partition each worker's
    // pool (`event_loop_worker.cpp`, `FORBID_REUSE=0`) and pay a fresh
    // handshake per change. Per-transfer matching stays cheap because it reads
    // this snapshot, never the database.
    loop_config.transport = vayu::http::resolve_transport_policy (db);
    // Run-scoped like the transport beside it (issue #1229). The load scope's
    // own compression setting is read here, because negotiating a compressed
    // response changes what the run measures.
    loop_config.default_headers = vayu::http::resolve_default_header_policy (
    db, vayu::http::DefaultHeaderScope::Load);
    // Every submission of either load shape is judged here, at the one place
    // all of them pass before the wire (#2521).
    loop_config.target_policy = context->target_policy;
    loop_config.max_response_body_bytes =
    vayu::http::routes::load_response_body_bound (db);
    // The same answers, for every `pm.sendRequest` the run's scripts make
    // (#1256, #2841): a script's fetch leaves the way the run's transfers
    // left and is bounded the way they are. See `RunContext::script_send`.
    context->script_send.transport       = loop_config.transport;
    context->script_send.default_headers = loop_config.default_headers;
    context->script_send.max_response_bytes = loop_config.max_response_body_bytes;
    context->script_send.request_timeout_ms = timeout_ms;
    // Stop and shutdown both raise `should_stop` (#3371), which also ends the
    // scripts (#3460; teardown reads `teardown_stop`). Not `aux_cancel`: the
    // worker raises that at every end before the replay and teardown run, whose
    // sends must still go out after a natural end.
    context->script_send.cancel = &context->should_stop;
    context->script_send.stop   = &context->should_stop;
    // Only enable curl verbose if explicitly requested in config,
    // independent of server verbose mode
    loop_config.verbose = config.value ("verbose", false);

    vayu::utils::log_debug ("run", "EventLoop config",
    { { "runId", context->run_id }, { "workers", configured_workers },
    { "maxConcurrent", loop_config.max_concurrent },
    { "maxPerHost", loop_config.max_per_host }, { "timeoutMs", timeout_ms } });

    // Published only once started, under the lock (#956); the docblock says
    // why.
    auto event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    event_loop->start ();
    context->publish_event_loop (std::move (event_loop));
}

namespace {

/// The bare column names @p context's rows bind (#1007), or none without rows.
const vayu::http::BoundColumnNames& run_bound_columns (const RunContext& context) {
    static const vayu::http::BoundColumnNames none;
    return context.load_data ? context.load_data->bound_columns : none;
}

/// Whether a single-request run names stored scopes: an `environmentId`, or a
/// `requestId` or `collectionId` whose collection chain they then include.
bool names_stored_scopes (const nlohmann::json& config) {
    return named_id (config, "environmentId") ||
    named_id (config, "requestId") || named_id (config, "collectionId");
}

/// Whether a single-request run's credentials hold a name only a variable scope
/// answers that only the start-of-run pass will answer (#3288): the run names
/// stored scopes and its submissions do not hold the credentials for their own
/// scripts (`LoadAuthPlan::after_scripts`). The build then leaves them alone,
/// as for a bind (#591), so `apply_auth` does not encode the name first.
bool credentials_resolve_at_start (const RunContext& context) {
    return !context.load_auth.after_scripts && names_stored_scopes (context.config) &&
    credentials_await_scripts (context.load_auth.auth, run_bound_columns (context));
}

/**
 * Whether the start-of-run pass resolves the request itself: it holds a token
 * and its submissions do not run the residual pass
 * (`submissions_run_the_residual_pass`), which resolves each copy against these
 * scopes and `script.setup`'s writes. Every other run, a `requestElements` run
 * sending the shared request included (#3288), resolves here, before
 * `script.setup`, so a setup write never reaches its request. This is asked
 * before the pass, so a stored value that is itself a bind token (`{{$guid}}`)
 * still moves the run onto the copy path, where a setup write to the name it
 * answered is lost.
 */
bool template_resolves_at_start (const RunContext& context, vayu::Request& request) {
    return !vayu::http::routes::unresolved_token_names (request).empty () &&
    !submissions_run_the_residual_pass (
    context, tokenize_bindable_fields (request, run_bound_columns (context)));
}

/// The credentials the build held back for the start-of-run pass, resolved
/// against @p vars and split again for the bind: applied to the shared request
/// when no bind-owned token is left in them, so the run keeps its one shared
/// request, else left for the bind per submission. Answers a refusal's message.
std::optional<std::string> resolve_credentials_at_start (RunContext& context,
vayu::Request& request,
const vayu::http::VariableValues& vars) {
    auto& plan          = context.load_auth;
    const auto& columns = run_bound_columns (context);
    auto refusal = vayu::http::routes::resolve_load_auth_tokens (plan.auth, vars, columns);
    plan.credentials = tokenize_auth_fields (plan.auth, columns);
    std::optional<std::string> message;
    if (refusal) {
        message = std::move (refusal->error.message);
    }
    if (!plan.credentials.empty ()) {
        return message;
    }
    // Applied even past a refusal, as `apply_late_auth` applies a header line
    // its value cannot be spelled in: the run sends it, and the pre-send gate
    // stops the line rather than the request going out with no credential.
    auto applied = vayu::http::apply_auth (request, plan.auth, nullptr);
    if (!message && !applied.ok) {
        message = std::move (applied.message);
    }
    return message;
}

/**
 * A single-request run that names stored scopes reads its `{{names}}` against
 * them as `POST /execute` does (#3253), in one pass at start over the template
 * every submission shares (`resolve_load_template_tokens`), before it is split,
 * when `template_resolves_at_start` says so. A template and credentials holding
 * no token read nothing, so a token-free run pays nothing (#992).
 *
 * Credentials the build held back (@p credentials_at_start, #3288) resolve
 * after the template, in the residual pass's order, so a basic pair or a
 * query-placed api key is encoded only once its names are answered.
 *
 * Counted, never fatal (#1503): a template refusal leaves what it refused
 * written, for the run's unresolved scan to name; a credential's is answered,
 * for the caller to count beside that scan. Both are logged here.
 */
std::optional<std::string> resolve_against_stored_scopes (vayu::db::Database& db,
RunContext& context,
vayu::Request& request,
bool credentials_at_start) {
    const bool template_at_start = names_stored_scopes (context.config) &&
    template_resolves_at_start (context, request);
    if (!template_at_start && !credentials_at_start) {
        return std::nullopt;
    }
    const auto vars = vayu::http::routes::flatten_variable_scopes (
    vayu::http::routes::load_script_variable_scopes (db, named_id (context.config, "environmentId"),
    single_request_lifecycle_collection_id (db, context.config)));
    if (template_at_start) {
        if (auto refusal = vayu::http::routes::resolve_load_template_tokens (
            request, vars, run_bound_columns (context))) {
            vayu::utils::log_warning ("run",
            "Load test: a stored variable was not resolved into the request",
            { { "runId", context.run_id },
            { "reason", vayu::utils::bounded_log_text (refusal->error.message) } });
        }
    }
    if (!credentials_at_start) {
        return std::nullopt;
    }
    auto refusal = resolve_credentials_at_start (context, request, vars);
    if (refusal) {
        vayu::utils::log_warning ("run",
        "Load test: a stored variable was not resolved into the credentials",
        { { "runId", context.run_id },
        { "reason", vayu::utils::bounded_log_text (*refusal) } });
    }
    return refusal;
}

/// Starts one refresh watchdog per credential in @p credentials, publishing
/// into `context->auth_refresh_states` in the same order, while the tokens just
/// resolved are still the cache's. The user's `oauth2Refresh*` settings are
/// read once here for every watchdog, so a run's schedule cannot change half
/// way through.
void arm_auth_refresh (vayu::db::Database& db,
vayu::db::Database* db_ptr,
const std::shared_ptr<RunContext>& context,
std::vector<vayu::http::AuthRefreshPlan> credentials) {
    if (credentials.empty ()) {
        return;
    }
    const AuthRefreshTuning tuning = read_auth_refresh_tuning (db);
    for (auto& credential : credentials) {
        auto state = std::make_shared<AuthRefreshState> (std::move (credential));
        context->auth_refresh_states.push_back (state);
        context->auth_refresh_threads.emplace_back ([context, state, db_ptr, tuning] () {
            run_auth_refresh (context, state, db_ptr, tuning);
        });
    }
}

} // namespace

/**
 * The one request a single-request load run sends, built once (deserialize,
 * timeout, auth) because the event loop attaches its headers to every transfer.
 *
 * A scenario load run has none: every step was composed and auth-resolved at
 * plan time, before the run row existed, and a step that could not be
 * authorized failed resolution with a 400; building here would compose the
 * payload's absent method and url. It arms the refresh of the OAuth 2.0 tokens
 * its steps were planned with.
 *
 * @return false when the payload cannot be built; the caller ends the run,
 *         Stopped when a Stop decided it and Failed otherwise.
 */
bool build_load_request (vayu::db::Database& db,
vayu::db::Database* db_ptr,
const nlohmann::json& config,
const std::shared_ptr<RunContext>& context,
int timeout_ms,
vayu::Request& request) {
    if (context->scenario) {
        auto refresh = plan_scenario_auth_refresh (context->scenario->plan, db_ptr);
        context->step_auth_refresh = std::move (refresh.step_credential);
        arm_auth_refresh (db, db_ptr, context, std::move (refresh.credentials));
        return true;
    }
    // Built once (deserialize + timeout + auth): the event loop attaches
    // request.headers to every transfer, so auth resolved here covers the run.
    //
    // The build leaves credentials alone when they must be resolved first: a
    // token must reach them before `apply_auth` base64s it out of reach (#591),
    // so `bind_iteration` applies them per submission; credentials waiting on
    // `requestElements` scripts (#2473) apply after each submission's residual
    // pass; credentials waiting on named stored scopes (#3288) apply in the
    // start-of-run pass below. Every other run resolves auth here.
    //
    // Asked of the credentials, not of the run's rows (#1055): `{{$vu}}` binds
    // off the iteration, so a run without `data` defers for it too, rather than
    // sending an identity token base64-encoded as written. The route's
    // pre-flight judged the token endpoints; judged again so no caller of the
    // run reaches one the policy refuses (#2521).
    const auto& target_policy       = context->target_policy;
    const bool credentials_at_start = credentials_resolve_at_start (*context);
    // A Stop or shutdown ends a token request in flight here (#3371).
    auto built = vayu::http::build_request (config, db_ptr, timeout_ms,
    credentials_at_start ? vayu::http::AuthResolution::Defer :
                           context->load_auth.auth_resolution (),
    target_policy ? &*target_policy : nullptr, &context->should_stop);
    if (!built.ok) {
        // The cancelled request answers as an auth failure; the Stop is what
        // ended it, so the caller ends the run Stopped and nothing failed.
        if (context->stop_decides_outcome ()) {
            vayu::utils::log_info ("run", "Load test stopped before its request was built",
            { { "runId", context->run_id } });
            return false;
        }
        vayu::utils::log_error ("run",
        built.parse_failed ? std::string ("Load test: invalid request format") :
                             "Load test auth resolution failed: " + built.error_message,
        { { "runId", context->run_id } });
        return false;
    }
    request = std::move (built.request);

    // Before the split and the scan below: what a stored scope answers is
    // finished text by then, so the split sees only the bind's tokens and the
    // scan names only what is left.
    auto credential_refusal =
    resolve_against_stored_scopes (db, *context, request, credentials_at_start);

    // Split once so no submission re-scans the request: a load run binds at
    // full rate, as a plan step is split when the plan resolves (#993). A
    // row-free run's `{}` set makes the join free.
    //
    // Unconditionally, not only with rows: the identity binds off the
    // iteration, so a run without `data` still carries `{{$vu}}` /
    // `{{$iteration}}` if its request spells them (#994). A request with no
    // reserved token leaves this empty, which makes the per-submission join one
    // `empty()` test.
    //
    // The run's own columns let a bare `{{username}}` split as a data token
    // (#1007); a run with no set names none, so the scan is reserved-only.
    context->load_template =
    tokenize_bindable_fields (request, run_bound_columns (*context));

    // Scanned here, while the request is owned and about to become the shared
    // template every fast-path submission sends unchanged (#1540): a bare
    // `{{token}}` with no data set and no credential splits nothing above, so
    // `load_template` stays empty and `submit_one_request`'s fast path never
    // copies the request to scan it. Once suffices: the fast path's bytes never
    // change between submissions.
    context->load_unresolved_tokens = vayu::http::routes::unresolved_token_names (request);
    // Counted per submission as the residual pass counts a late credential's
    // refusal (`resolve_load_residuals`), never fatal (#1503).
    if (credential_refusal) {
        context->load_unresolved_tokens.push_back (std::move (*credential_refusal));
    }

    // A streaming run's caps ride on the request, the only thing the enforcing
    // event loop sees. Attached after `build_request`, not inside: they belong
    // to *this* run's execution model, and the same builder serves
    // `POST /execute`, whose stream `SseStreamManager` manages and which must
    // not acquire load bounds (#576).
    request.stream_bounds = context->stream_bounds;

    // The file rule (`http/file_ref.hpp`), once for the run: filled from the
    // route's plan, or checked here for a run started without one. A path a
    // row binds is filled per submission from the same plan instead.
    if (vayu::http::has_file_refs (request.body)) {
        std::optional<std::string> refusal;
        if (!context->file_plan) {
            context->file_plan = std::make_shared<vayu::http::FilePlan> (
            vayu::http::FileAccessPolicy::from_database (db));
            refusal = plan_load_files (
            *context->file_plan, request, context->load_data.get ());
        } else if (!vayu::http::has_templated_file_path (request.body)) {
            refusal = context->file_plan->fill (request);
        }
        if (refusal) {
            vayu::utils::log_error (
            "run", "Load test: " + *refusal, { { "runId", context->run_id } });
            return false;
        }
    }

    // Inert for every auth that cannot be refreshed mid-run - see
    // plan_auth_refresh for that list.
    if (auto plan = vayu::http::plan_auth_refresh (
        request, config.value ("auth", nlohmann::json ()), db_ptr)) {
        std::vector<vayu::http::AuthRefreshPlan> credentials;
        credentials.push_back (std::move (*plan));
        arm_auth_refresh (db, db_ptr, context, std::move (credentials));
    }
    return true;
}

/** What a load run spent on either side of its load window (#2894). */
struct RunOverheads {
    double setup_s   = 0.0; // `execute_load_test`'s entry to load start
    double cleanup_s = 0.0; // load end to the auxiliary threads joined
};

/** The measured figures a finished run's summary is built from. */
struct RunTotals {
    size_t completed               = 0;
    double actual_rps              = 0.0;
    double total_duration_s        = 0.0;
    double sending_window_s        = 0.0;
    size_t completed_while_sending = 0;
    RunOverheads overheads;
    double latency_avg_ms = 0.0;
    MetricsCollector::Percentiles latency;
};

namespace {
/// The warning for @p replays requests libcurl re-sent on a new connection
/// (#2799). Each stays counted as one request, never an error, so this is the
/// only place a reader learns the target saw more than the run did.
nlohmann::json connection_replayed_warning (size_t replays) {
    const std::string count = std::to_string (replays);
    const bool one          = replays == 1;
    return { { "code", "connection_replayed" },
        { "message",
        count + (one ? " request was" : " requests were") +
        " re-sent on a new connection after the server dropped or refused a "
        "reused one. The target received " +
        count + (one ? " more request" : " more requests") +
        " than were counted, and each of those shows the time of both "
        "attempts. A non-idempotent request may have run twice at the "
        "target." },
        { "count", replays } };
}

/// The warning for @p headers `Set-Cookie` headers libcurl's cookie engine
/// discarded across the run (#3307). A count, never a name: a run is shared as
/// a report, and a name repeated per virtual user says nothing a count does
/// not.
nlohmann::json cookies_dropped_warning (size_t headers) {
    const bool one = headers == 1;
    return { { "code", "cookies_dropped" },
        { "message",
        std::to_string (headers) + (one ? " Set-Cookie header was" : " Set-Cookie headers were") +
        " dropped across the run by libcurl's cookie engine (a line over " +
        std::to_string (vayu::http::SET_COOKIE_LINE_LIMIT_BYTES) + " bytes, a name and value over " +
        std::to_string (vayu::http::COOKIE_NAME_VALUE_LIMIT_BYTES) + " bytes, or more than " +
        std::to_string (vayu::http::SET_COOKIES_PER_RESPONSE_LIMIT) +
        " in one response), so the virtual users that received " +
        (one ? "it sent their later steps without that cookie." :
               "them sent their later steps without those cookies.") },
        { "count", headers } };
}

/**
 * With `retryAfterBackoff` off, the warning for a run most of whose responses
 * (more than half of those carrying a status; a transport failure carries none)
 * were 429 (#3782): its figures describe the target's rate limit. A closed-loop
 * run's message names the option that would have backed off; a constant-rate
 * run's does not, since the option never applies there
 * (`RunContext::honour_retry_after`) and turning it on only raises
 * `retry_after_skipped_open_loop`. A run with responses reached its strategy,
 * so `closed_loop` is meaningful here.
 */
std::optional<nlohmann::json> rate_limited_dominant_warning (const RunContext& context) {
    size_t responses = 0;
    size_t limited   = 0;
    for (const auto& [status, count] :
    context.metrics_collector->status_code_distribution ()) {
        responses += status == 0 ? 0 : count;
        limited += status == 429 ? count : 0;
    }
    if (limited * 2 <= responses) {
        return std::nullopt;
    }
    const bool closed_loop = context.closed_loop.load (std::memory_order_relaxed);
    return std::make_optional<nlohmann::json> ({ { "code", "rate_limited_dominant" },
    { "message",
    std::to_string (limited) + " of " + std::to_string (responses) +
    " responses were 429 Too Many Requests, so this report describes the "
    "target's rate limit more than the target. " +
    (closed_loop ?
    "Set retryAfterBackoff to have each virtual user wait out the "
    "Retry-After the target sends before its next request." :
    "Retry-After back-off applies only to runs that send one request "
    "after another, not to constant-rate runs.") },
    { "count", limited } });
}

/**
 * What the run's Retry-After back-off (#3782) changed about what it measured,
 * as at most one warning: with the option off, a run dominated by 429s; on,
 * the constant-rate run it could not apply to, or the waits it took.
 */
std::optional<nlohmann::json> retry_after_warning (const RunContext& context) {
    if (!context.retry_after_backoff) {
        return rate_limited_dominant_warning (context);
    }
    // A run that sent nothing never reached its strategy, and `closed_loop`
    // reads false there whatever the mode.
    if (context.requests_sent.load () == 0) {
        return std::nullopt;
    }
    if (!context.closed_loop.load (std::memory_order_relaxed)) {
        return std::make_optional<nlohmann::json> ({ { "code", "retry_after_skipped_open_loop" },
        { "message", RunContext::OPEN_LOOP_RETRY_AFTER_SKIP_REASON } });
    }
    const size_t waits = context.metrics_collector->retry_after_waits ();
    if (waits == 0) {
        return std::nullopt;
    }
    return std::make_optional<nlohmann::json> ({ { "code", "retry_after_backoff" },
    { "message",
    std::to_string (waits) + (waits == 1 ? " response" : " responses") +
    " asked for a Retry-After wait, and the virtual user that received " +
    (waits == 1 ? "it" : "each") + " waited it out (at most " +
    std::to_string (context.retry_after_max_ms) +
    " ms) before its next request, so this run's rate is the one the "
    "target allowed." },
    { "count", waits } });
}

/// Whether @p config asks for virtual users, by carrying a `concurrency`. A run
/// without one (every `constant_rps` run the app starts) is sized from the
/// `eventLoopMaxConcurrent` default, so its per-host raise covers no virtual
/// user and needs no warning (#2801).
bool declares_concurrency (const nlohmann::json& config) {
    const auto concurrency = config.find ("concurrency");
    return concurrency != config.end () && !concurrency->is_null ();
}

/// How many of a single-request run's enabled `requestElements` its open-loop
/// pacer skipped (`RunContext::open_loop_timer_skip_reason`, #3541). A run that
/// sent nothing never reached its strategy, where `closed_loop` reads false
/// whatever the mode, so it counts none.
size_t open_loop_skipped_timers (const RunContext& context) {
    if (!context.step_elements || context.requests_sent.load () == 0) {
        return 0;
    }
    const auto& elements = *context.step_elements;
    return static_cast<size_t> (std::count_if (elements.begin (),
    elements.end (), [&context] (const vayu::core::CompiledElement& element) {
        return element.enabled &&
        context.open_loop_timer_skip_reason (element).has_value ();
    }));
}
} // namespace

/**
 * What this run did not do, as the summary's `warnings` array (#1503):
 * - a `{{token}}` that never resolved (no mode runs a residual pass under load,
 *   so this is all a caller learns of one), and for a scenario run a step whose
 *   pre-request script did not run inline (#1938). Neither refuses the run: a
 *   literal `{{` can be deliberate in a body, and a run that sent every request
 *   must still be reported finished;
 * - a per-host connection limit raised above `eventLoopMaxPerHost` (#2394) to
 *   cover the virtual users asked for (#2801), so opening more connections than
 *   the setting says is not silent;
 * - requests libcurl re-sent on a new connection (#2799), `Set-Cookie` headers
 *   its cookie engine discarded (#3307), the think timers a constant-rate run
 *   skipped (#3541), and what Retry-After back-off did or would have done
 *   (#3782).
 *
 * Empty for a run with nothing to say, which lets the caller omit the key.
 */
nlohmann::json build_run_warnings (const std::shared_ptr<RunContext>& context) {
    nlohmann::json warnings = nlohmann::json::array ();

    if (const size_t affected = context->metrics_collector->unresolved_token_requests ();
    affected > 0) {
        const auto names = context->metrics_collector->unresolved_token_names ();
        std::string message = std::to_string (affected) +
        (affected == 1 ? " request sent with an unresolved variable" :
                         " requests sent with unresolved variables");
        if (!names.empty ()) {
            message += ": ";
            for (size_t i = 0; i < names.size (); ++i) {
                message += (i == 0 ? "" : ", ") + names[i];
            }
        }
        warnings.push_back ({ { "code", "unresolved_tokens" },
        { "message", message }, { "count", affected }, { "names", names } });
    }

    if (context->effective_max_per_host > context->configured_max_per_host &&
    declares_concurrency (context->config)) {
        warnings.push_back ({ { "code", "per_host_limit_raised" },
        { "message",
        "Connections per host raised from " + std::to_string (context->configured_max_per_host) +
        " to " + std::to_string (context->effective_max_per_host) +
        " per worker to cover this run's virtual users" },
        { "configured", context->configured_max_per_host },
        { "effective", context->effective_max_per_host } });
    }

    if (const size_t replays = context->metrics_collector->connection_replays ();
    replays > 0) {
        warnings.push_back (connection_replayed_warning (replays));
    }

    if (const size_t dropped = context->metrics_collector->set_cookie_headers_dropped ();
    dropped > 0) {
        warnings.push_back (cookies_dropped_warning (dropped));
    }

    if (context->scenario) {
        const auto& steps  = context->scenario->plan.steps;
        const auto skipped = static_cast<size_t> (
        std::count_if (steps.begin (), steps.end (), [&] (const ScenarioStep& step) {
            return step_has_deferred_script (step, "script.pre", context->scripts_override);
        }));
        if (skipped > 0) {
            warnings.push_back ({ { "code", "pre_request_script_skipped" },
            { "message",
            std::to_string (skipped) +
            (skipped == 1 ?
            " step carries a pre-request script that does not run under "
            "load" :
            " steps carry a pre-request script that does not run under "
            "load") },
            { "steps", skipped } });
        }
    }

    if (const size_t timers = open_loop_skipped_timers (*context); timers > 0) {
        warnings.push_back ({ { "code", "think_timer_skipped_open_loop" },
        { "message", RunContext::OPEN_LOOP_TIMER_SKIP_REASON }, { "timers", timers } });
    }

    if (auto warning = retry_after_warning (*context)) {
        warnings.push_back (std::move (*warning));
    }

    return warnings;
}

AssertionTotals exact_assertion_totals (const RunContext& context,
const ScenarioLoadState* scenario_state) {
    // The counters alone, never plus the element tallies: `record_assertion`
    // appends each `assert.*` outcome to the step's script results, so it is
    // already counted here.
    const auto& passed = scenario_state != nullptr ? scenario_state->inline_tests_passed :
                                                     context.inline_tests_passed;
    const auto& failed = scenario_state != nullptr ? scenario_state->inline_tests_failed :
                                                     context.inline_tests_failed;
    return { .passed = passed.load (std::memory_order_relaxed),
        .failed      = failed.load (std::memory_order_relaxed) };
}

namespace {

/// What `maxAssertionFailureRatePct` judges: the exact population beside the
/// deferred replay's sampled one (#2892). Absent when the run made no
/// assertion, so the budget stays unevaluated rather than passing at 0/0.
std::optional<AssertionPopulations> assertion_populations (const RunContext& context,
const ScriptValidation& validation,
const ScenarioLoadState* scenario_state) {
    AssertionPopulations populations;
    populations.exact = exact_assertion_totals (context, scenario_state);
    if (validation.run) {
        populations.sampled = { .passed = validation.run->passed,
            .failed                     = validation.run->failed };
        populations.sample_rate = context.metrics_collector->response_sample_rate ();
    }
    if (populations.exact.total () + populations.sampled.total () == 0) {
        return std::nullopt;
    }
    return populations;
}

} // namespace

/** Everything the stored whole-run summary is built from. */
RunSummaryInputs collect_summary_inputs (const std::shared_ptr<RunContext>& context,
const RunTotals& totals,
const ScriptValidation& validation,
const SampledValidationTotals& schema_totals,
const std::shared_ptr<ScenarioLoadState>& scenario_state) {
    RunSummaryInputs inputs;
    inputs.total_requests     = totals.completed;
    inputs.cancelled          = context->metrics_collector->cancelled ();
    inputs.drain_cut          = context->drain_cut (inputs.cancelled);
    inputs.rps                = totals.actual_rps;
    inputs.throughput         = totals.actual_rps;
    inputs.test_duration_s    = totals.total_duration_s;
    inputs.setup_overhead_s   = totals.overheads.setup_s;
    inputs.cleanup_overhead_s = totals.overheads.cleanup_s;
    inputs.peak_concurrency   = context->peak_in_flight.load ();
    inputs.avg_in_flight =
    context->metrics_collector->average_in_flight (totals.total_duration_s);
    inputs.dropped_requests = context->metrics_collector->dropped_requests ();
    inputs.skipped_requests = context->metrics_collector->skipped_requests ();
    inputs.stalled_ms       = context->metrics_collector->stalled_ms ();
    // Over the window the run sent in, which leaves out the drain (#2392).
    inputs.requests_sent           = context->requests_sent.load ();
    inputs.requests_expected       = context->requests_expected.load ();
    inputs.sending_duration_s      = totals.sending_window_s;
    inputs.completed_while_sending = totals.completed_while_sending;
    inputs.send_rate               = totals.sending_window_s > 0 ?
    static_cast<double> (inputs.requests_sent) / totals.sending_window_s :
    0.0;
    inputs.queue_wait_avg_ms = context->metrics_collector->average_queue_wait ();
    inputs.bytes_sent     = context->metrics_collector->total_bytes_sent ();
    inputs.bytes_received = context->metrics_collector->total_bytes_received ();
    inputs.status_codes = context->metrics_collector->status_code_distribution ();
    inputs.error_types    = context->metrics_collector->error_type_counts ();
    inputs.error_classes  = context->metrics_collector->error_class_counts ();
    inputs.latency        = totals.latency;
    inputs.latency_avg_ms = totals.latency_avg_ms;
    inputs.phases         = context->metrics_collector->phase_percentiles ();
    inputs.phase_means    = context->metrics_collector->phase_means ();
    inputs.stream         = context->metrics_collector->stream_totals ();
    inputs.custom_metrics = context->metrics_collector->custom_metric_summaries ();
    inputs.http_version_downgraded =
    context->metrics_collector->http_version_downgraded ();
    inputs.connection_replays = context->metrics_collector->connection_replays ();
    inputs.tests = validation.run;
    // Written by the capacity strategy before its execute() returned,
    // so it is already final here; absent for every other mode.
    inputs.capacity          = context->capacity;
    inputs.retention         = read_retention (*context->metrics_collector);
    inputs.slow_total        = context->metrics_collector->slow_total ();
    inputs.slow_threshold_ms = context->slow_threshold_ms;
    // Safe to read unlocked: the scrape thread is its only writer and
    // was joined above, which is the happens-before edge.
    if (context->monitor_totals) {
        inputs.monitor = context->monitor_totals->to_summary ();
    }
    // Read only now, after the drain above: a completion callback can
    // still be advancing a VU while the strategy's own frame has
    // already returned, so the tallies are only final here.
    if (scenario_state) {
        inputs.scenario =
        build_scenario_load_summary (*scenario_state, context->scenario->plan);
        // Which step's assertions failed, beside what that step did.
        // The whole-run `tests` section above says only that something
        // failed, which over a sequence is not an answer.
        attach_step_test_totals (*inputs.scenario, validation.steps);
        // The exact population, the figure the budget's `assertionsExact`
        // reads (#2820). Absent, not zeros, for a run that asserted nothing.
        if (const auto exact = exact_assertion_totals (*context, scenario_state.get ());
        exact.total () > 0) {
            (*inputs.scenario)["assertions"] = { { "passed", exact.passed },
                { "failed", exact.failed } };
        }
        // Read on the same edge for the same reason: a completion still in
        // flight is a request this contract was exercised with (#629). Empty
        // for a run of an unbound collection, which the payload builder treats
        // as absent.
        inputs.coverage = build_scenario_load_coverage (*scenario_state);
    } else if (context->step_elements && !context->step_elements->empty ()) {
        // A single-request run's own step-level elements (issue #1594) - the
        // single-request sibling of the `scenario_state` block above, read
        // the same way after the same drain.
        auto built = context->element_tallies.build (*context->step_elements);
        if (!built.empty ()) {
            inputs.elements = std::move (built);
        }
    }
    inputs.assertions =
    assertion_populations (*context, validation, scenario_state.get ());
    // Beside coverage, deliberately not inside the `scenario_state` block: this
    // pass reads the collector's sample reservoirs, there whether or not the
    // executor left a state. An empty object is absent.
    inputs.schema_validation = build_sampled_validation_payload (schema_totals);

    // Judged last, off the filled inputs rather than the collector, so the
    // verdict comes from the numbers the summary stores and no report prints a
    // p99 its own verdict disagrees with. A run stopped early is judged on what
    // it measured.
    inputs.thresholds = evaluate_thresholds (context->config, inputs);
    // What the refresh watchdogs did, for a run that had any. Read after
    // the join above, so the tallies are final.
    inputs.auth = AuthRefreshState::summarize (context->auth_refresh_states);
    inputs.warnings = build_run_warnings (context);
    return inputs;
}

/**
 * The run-level `ScriptConfig` `script.setup` / `script.teardown` (#1499) share
 * with every other script of the run, read once here rather than at each
 * dispatch site. No `record_script_requests`: a load run's scripts are excluded
 * from the `pm.sendRequest` records (#3633) whole, setup and teardown with
 * them, though their `lifecycle` row could carry them; opting in is that one
 * call.
 */
vayu::runtime::ScriptConfig read_lifecycle_script_config (vayu::db::Database& db,
const nlohmann::json& config) {
    vayu::runtime::ScriptConfig script_config = vayu::core::read_script_config (db);
    script_config.allow_send_request = vayu::http::read_allow_script_requests (config);
    return script_config;
}

/// A single-request run's own `lifecycleElements` (#1573), compiled once: this
/// shape's ephemeral equivalent of a collection's `elements` column, validated
/// at the route (`validate_lifecycle_elements_run_override`) to hold only
/// `script.setup` / `script.teardown`. Empty when the payload declared none.
std::vector<vayu::core::CompiledElement> compile_run_lifecycle_elements (
const nlohmann::json& config) {
    auto lifecycle = config.find ("lifecycleElements");
    if (lifecycle == config.end () || !lifecycle->is_array ()) {
        return {};
    }
    // Stamped as `validate_lifecycle_elements_run_override` validated it, so an
    // element with no id gets one rather than the empty `CompiledElement::id`
    // default, which the report's `lifecycle.setup` / `.teardown` outcomes
    // would carry verbatim.
    nlohmann::json stamped = *lifecycle;
    vayu::core::stamp_default_element_ids (stamped);
    return vayu::core::compile_elements (stamped);
}

/// A scenario load run's `script.setup` (#1499, #3456): resolves the lifecycle
/// set once onto `context->lifecycle`, loads @p scopes for it and every step
/// (`scenario_load_scopes`), and runs each collection's setups bound to that
/// collection through the `run_scenario_setup` a sequential run uses, so a
/// folder's setup writes reach the bases of that folder's steps and the folders
/// below.
std::optional<std::string> run_scenario_load_setup (vayu::db::Database& db,
const std::shared_ptr<RunContext>& context,
std::optional<vayu::http::routes::RunVariableScopes>& scopes) {
    const ScenarioExecution& execution = *context->scenario;
    context->lifecycle = std::make_shared<const std::vector<LifecycleCollection>> (
    resolve_lifecycle_collections (
    db, execution.request.collection_id, execution.request.recursive));
    auto& run_scopes = scopes.emplace (scenario_load_scopes (db,
    named_id (context->config, "environmentId"), execution, *context->lifecycle));
    if (context->lifecycle->empty ()) {
        return std::nullopt;
    }
    vayu::runtime::ScriptEngine setup_engine (
    read_lifecycle_script_config (db, context->config));
    auto refusal = run_scenario_setup (setup_engine, run_scopes,
    context->script_send, *context->lifecycle, context->setup_outcomes);
    // A virtual user's local scope starts empty each iteration (#2564), and
    // setup is no user's iteration, so its `pm.variables.set` ends with it
    // rather than reaching every user through the bases.
    run_scopes.clear_local ();
    return refusal;
}

/// A single-request load run's `script.setup`, read from its own
/// `lifecycleElements` since it has no collection (#1573). The scopes it leaves
/// are kept on `context->lifecycle_scopes` (this shape has no
/// `ScenarioLoadState` for `run_collection_teardown` to read back), and
/// flattened onto `context->step_base_vars` after setup for a run whose
/// `requestElements` read them (#1594).
std::optional<std::string> run_request_lifecycle_setup (vayu::db::Database& db,
const std::shared_ptr<RunContext>& context) {
    const auto lifecycle_elements = compile_run_lifecycle_elements (context->config);
    const bool has_step_elements =
    context->step_elements && !context->step_elements->empty ();
    if (lifecycle_elements.empty () && !has_step_elements) {
        return std::nullopt;
    }
    auto scopes = vayu::http::routes::load_script_variable_scopes (db,
    named_id (context->config, "environmentId"),
    single_request_lifecycle_collection_id (db, context->config));
    if (!lifecycle_elements.empty ()) {
        vayu::runtime::ScriptEngine setup_engine (
        read_lifecycle_script_config (db, context->config));
        run_setup_elements (setup_engine, scopes, context->script_send,
        lifecycle_elements, context->setup_outcomes);
        // Setup is no submission's, so its local scope ends with it, as a
        // scenario run's does.
        scopes.local.clear ();
    }
    context->lifecycle_scopes = scopes;
    if (has_step_elements) {
        context->step_base_vars = vayu::http::routes::flatten_variable_scopes (scopes);
        context->step_script_config = read_lifecycle_script_config (db, context->config);
        const auto identity = read_run_script_identity (db, context->config);
        context->script_request_id   = identity.request_id;
        context->script_request_name = identity.request_name;
    }
    return lifecycle_refusal (context->setup_outcomes);
}

/**
 * `script.setup` (#1499), dispatched by `execute_load_test` before it captures
 * `test_start`, so a setup script's time is never in the run's duration figures
 * and a refusing setup fails the run before any load. A scenario run's
 * @p scenario_scopes are loaded here and handed to `execute_scenario_load`, so
 * a setup write reaches the run's first submission, as a sequential run's first
 * step; a single-request run leaves them empty.
 *
 * @return `nullopt` on success, else the refusing outcome's message. On failure
 *         the caller only has to stop the run; this does not touch
 *         `context->is_running` or the run's status, since only the caller
 *         knows the rest of its shutdown.
 */
std::optional<std::string> run_collection_setup (vayu::db::Database& db,
const std::shared_ptr<RunContext>& context,
std::optional<vayu::http::routes::RunVariableScopes>& scenario_scopes) {
    if (context->scenario) {
        return run_scenario_load_setup (db, context, scenario_scopes);
    }
    return run_request_lifecycle_setup (db, context);
}

/**
 * `script.teardown` (#1499), dispatched by `finish_load_test` so `pm.info.run`
 * can carry @p run_summary_info. A scenario run tears down the lifecycle set
 * its setup resolved (`context->lifecycle`, #3456), in reverse, on a copy of
 * setup's scopes (`ScenarioLoadState::lifecycle_scopes`); a single-request run
 * re-reads its `lifecycleElements` against `context->lifecycle_scopes` (#1573).
 * A throw never reaches the caller's `final_status`: `ElementPipeline::run`
 * turns it into the element's `"error"` outcome. Empty for a scenario load run
 * whose driver never started (no `scenario_state`) or a run that declared no
 * `script.teardown`.
 */
std::vector<vayu::core::ElementOutcome> run_collection_teardown (vayu::db::Database& db,
const std::shared_ptr<RunContext>& context,
const std::shared_ptr<ScenarioLoadState>& scenario_state,
const vayu::runtime::RunSummaryInfo& run_summary_info) {
    auto teardown_send = context->script_send;
    teardown_send.stop = context->teardown_stop ();
    if (context->scenario) {
        if (!scenario_state || !context->lifecycle || context->lifecycle->empty ()) {
            return {};
        }
        vayu::runtime::ScriptEngine teardown_engine (
        read_lifecycle_script_config (db, context->config));
        // A copy: the run's scopes are the bases' source and stay as setup
        // left them, and a load run persists nothing.
        auto scopes = scenario_state->lifecycle_scopes;
        return run_scenario_teardown (teardown_engine, scopes, teardown_send,
        *context->lifecycle, run_summary_info);
    }
    const auto lifecycle_elements = compile_run_lifecycle_elements (context->config);
    std::vector<vayu::core::ElementOutcome> teardown_outcomes;
    if (lifecycle_elements.empty ()) {
        return teardown_outcomes;
    }
    vayu::runtime::ScriptEngine teardown_engine (
    read_lifecycle_script_config (db, context->config));
    run_teardown_elements (teardown_engine, context->lifecycle_scopes,
    teardown_send, lifecycle_elements, run_summary_info, teardown_outcomes);
    return teardown_outcomes;
}

/** The window a run sent in, and what completed inside it. */
struct SendingWindow {
    double seconds = 0.0;
    /// Empty when the window is the whole run: every completion is inside it.
    std::optional<size_t> completed;
};

/**
 * The window a run's send rate and rate fidelity divide by (#2392), and the
 * completions inside it (#2882): @p measured_s, load start to the executor's
 * return, and @p completed_at_send_end, both read before the drain
 * @p total_duration_s includes. An `iterations` run that reached its own end
 * gets the whole run (`returns_at_send_deadline` says why); a stopped one
 * returned on seeing the Stop, so its measured window stands. A Stop landing
 * after the strategy returned ended no sending and changes nothing.
 */
SendingWindow sending_window (const RunContext& context,
double measured_s,
size_t completed_at_send_end,
double total_duration_s) {
    if (context.stop_decides_outcome () || returns_at_send_deadline (context.config)) {
        return { measured_s, completed_at_send_end };
    }
    return { total_duration_s, std::nullopt };
}

/// What this run's worker left its deferred replay to start from, @p request
/// being the one `build_load_request` built. A single-request run's setup loads
/// its scopes whenever it carries `requestElements`
/// (`run_request_lifecycle_setup`), the source of every replayed script.
ReplayBase replay_base (const RunContext& context,
const vayu::Request& request,
const ScenarioLoadState* scenario_state) {
    ReplayBase base;
    if (context.scenario) {
        base.scenario_state = scenario_state;
        return base;
    }
    base.shared_request = &request;
    if (context.step_elements && !context.step_elements->empty ()) {
        base.request_scopes = &context.lifecycle_scopes;
    }
    return base;
}

/**
 * Everything a finished run leaves behind: the flush, the two deferred passes,
 * the stored summary and the terminal status. @p request is the one a
 * single-request run's submissions copied, from which the replay re-derives
 * each sample's. Each step is guarded on its own, so a failing one costs only
 * what it was about to write: a run that measured something must still be
 * reported finished.
 */
void finish_load_test (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
double total_duration_s,
const SendingWindow& sending,
const RunOverheads& overheads,
double target_rps,
const vayu::Request& request,
const std::shared_ptr<ScenarioLoadState>& scenario_state) {
    size_t completed   = context->total_requests ();
    double avg_latency = context->average_latency_ms ();
    double actual_rps =
    total_duration_s > 0 ? static_cast<double> (completed) / total_duration_s : 0.0;
    const auto failures = vayu::count_status_failures (
    context->metrics_collector->status_code_distribution ());

    auto percentiles = context->metrics_collector->calculate_percentiles ();

    // Batch flush all results to database (errors and sampled successes)
    try {
        size_t flushed = context->metrics_collector->flush_to_database (db);
        if (flushed > 0) {
            vayu::utils::log_debug ("run", "Flushed results to database",
            { { "runId", context->run_id }, { "count", flushed } });
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "Failed to flush results to database, the chunks written before the "
        "failure are kept: " +
        std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    // Run deferred script validation if test script is present. Its tallies
    // go into the summary below, so it has to run before the summary write.
    ScriptValidation validation;
    try {
        validation = validate_scripts (
        context, db, replay_base (*context, request, scenario_state.get ()));
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "Script validation failed: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    // The other deferred pass over the same reservoirs (#682): what the bound
    // contract says about the responses that survived sampling. Here, beside
    // the script replay, for its reason: the completion path refills
    // concurrency, and neither pass may be on it.
    SampledValidationTotals schema_totals;
    try {
        schema_totals = validate_sampled_responses (context);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "Schema validation failed: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    // `script.teardown` (#1499): the collection-level elements `script.setup`
    // ran at the top of `execute_load_test`, dispatched here so `pm.info.run`
    // carries this pass's totals, which is why it runs after schema validation
    // rather than straight after the drain.
    vayu::runtime::RunSummaryInfo run_summary_info;
    run_summary_info.requests_sent = completed;
    run_summary_info.error_rate    = failures.error_rate ();
    run_summary_info.assertions_passed = validation.run ? validation.run->passed : 0;
    run_summary_info.assertions_failed = validation.run ? validation.run->failed : 0;
    auto teardown_outcomes =
    run_collection_teardown (db, context, scenario_state, run_summary_info);

    // The whole-run summary, written once here: everything the report would
    // otherwise rebuild by scanning the run's metric rows. Hoisted out of the
    // try so the terminal-status decision below reads its verdict, never a
    // second query for the budgets (a core that reads, decides and writes holds
    // one lock; engine/CLAUDE.md).
    RunSummaryInputs inputs;
    bool summary_stored = false;
    try {
        RunTotals totals;
        totals.completed               = completed;
        totals.actual_rps              = actual_rps;
        totals.total_duration_s        = total_duration_s;
        totals.sending_window_s        = sending.seconds;
        totals.completed_while_sending = sending.completed.value_or (completed);
        totals.overheads               = overheads;
        totals.latency_avg_ms          = avg_latency;
        totals.latency                 = percentiles;

        inputs = collect_summary_inputs (
        context, totals, validation, schema_totals, scenario_state);
        inputs.lifecycle =
        vayu::core::build_lifecycle_node (context->setup_outcomes, teardown_outcomes);
        db.update_run_summary (
        context->run_id, build_run_summary_payload (inputs).dump ());
        summary_stored = true;
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "Failed to store run summary: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    // A stopped run reports Stopped whatever the verdict (#1497's failRun
    // judges only a run that reached its natural end); a completed run with
    // `thresholds.failRun: true` that missed its budgets is judged too, a Stop
    // during its drain included. The move keeps the end_time stamped before
    // cleanup.
    const bool stopped = context->stop_decides_outcome ();
    vayu::RunStatus final_status =
    stopped ? vayu::RunStatus::Stopped : vayu::RunStatus::Completed;
    if (!stopped && summary_stored && inputs.thresholds &&
    inputs.thresholds->failed > 0 && thresholds_fail_run (context->config)) {
        final_status = vayu::RunStatus::Failed;
    }
    db.transition_run_status (context->run_id, { vayu::RunStatus::Running }, final_status);

    // Terminal status reached - trim old runs per the retention knobs.
    // Best-effort: a prune failure must not fail the completed run.
    try {
        db.prune_runs_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("run", "Run pruning failed: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    vayu::utils::log_debug ("run",
    std::string ("Load test ") + vayu::to_string (final_status),
    { { "runId", context->run_id }, { "totalRequests", completed },
    { "errors", failures.failed }, { "errorRate", failures.error_rate () },
    { "durationS", total_duration_s }, { "targetRps", target_rps },
    { "actualRps", actual_rps }, { "avgLatencyMs", avg_latency },
    { "p50", percentiles.p50 }, { "p95", percentiles.p95 }, { "p99", percentiles.p99 } });
}

namespace {

/**
 * A failed run's summary, from whatever its collector holds; without one the
 * report route takes the legacy path and reports an empty run. Call after
 * `join_aux_threads` and before the status flips to Failed: the terminal status
 * tells a polling client the report is ready, so one fetching on it must not
 * race a summary still being written.
 */
void store_failed_run_summary (vayu::db::Database& db, const RunContext& context) {
    try {
        db.update_run_summary (context.run_id,
        build_run_summary_payload (failed_run_summary_inputs (context)).dump ());
    } catch (const std::exception& ex) {
        vayu::utils::log_error ("run",
        "Failed to store run summary for failed run: " + std::string (ex.what ()),
        { { "runId", context.run_id } });
    }
}

} // namespace

void execute_load_test (const std::shared_ptr<RunContext>& context,
vayu::db::Database* db_ptr,
RunManager& manager) {
    // The origin of the summary's setup overhead (#2894): everything from
    // here to `test_start`, the configure and `script.setup` included.
    const auto entry = std::chrono::steady_clock::now ();

    // Note: is_running is set in spawn_run() before threads spawn to avoid a
    // race with metrics_thread; the load-start stamp is set below.

    // The pacing thread for every load strategy (constant_rps's
    // wait_for_next_tick included): never pinned, only nudged above default, as
    // the timing-sensitive one whose own work is negligible CPU (submission and
    // sleeping; the event loop workers drive the transfers).
    raise_pacing_thread_priority ();

    auto& db           = *db_ptr;
    const auto& config = context->config;

    try {
        // Only from Pending (#3340): a Stop that reached the row before this
        // run registered found no context and left it Stopped, and a deleted
        // row is gone. Either way the run ends here, sending nothing and
        // writing no status over the one that refused it.
        if (!db
            .transition_run_status (context->run_id,
            { vayu::RunStatus::Pending }, vayu::RunStatus::Running)
            .applied) {
            context->is_running = false;
            context->join_aux_threads ();
            manager.retain_run (context->run_id);
            return;
        }

        // Get defaults from config (set via Settings UI)
        int default_max_concurrent = db.get_config_int (
        "eventLoopMaxConcurrent", vayu::core::constants::event_loop::MAX_CONCURRENT);
        int default_max_per_host = db.get_config_int (
        "eventLoopMaxPerHost", vayu::core::constants::event_loop::MAX_PER_HOST);
        // Resolved the same way /health reports it (vayu::core::resolve_worker_count),
        // so the two numbers cannot drift apart.
        int configured_workers = vayu::core::resolve_worker_count (db);

        // Per-test config can override defaults
        size_t concurrency =
        static_cast<size_t> (config.value ("concurrency", default_max_concurrent));
        const double target_rps = open_loop_rate (config); // 0 = unlimited
        // Resolved per run, never written into `config_snapshot`: a replayed
        // snapshot would turn today's setting into an explicit timeout.
        const int timeout_ms =
        vayu::http::routes::resolve_request_timeout_ms (config, db);

        configure_event_loop (db, config, context, concurrency, timeout_ms,
        configured_workers, default_max_per_host);

        vayu::Request request;
        if (!build_load_request (db, db_ptr, config, context, timeout_ms, request)) {
            db.transition_run_status (context->run_id, { vayu::RunStatus::Running },
            context->stop_decides_outcome () ? vayu::RunStatus::Stopped :
                                               vayu::RunStatus::Failed);
            context->is_running = false;
            context->join_aux_threads ();
            manager.retain_run (context->run_id);
            return;
        }

        // `script.setup` (#1499): the lifecycle set's once-per-run elements
        // (#3456), run (and on failure refused) before `test_start` is
        // captured; `run_collection_setup` says why.
        std::optional<vayu::http::routes::RunVariableScopes> scenario_scopes;
        if (auto setup_failure = run_collection_setup (db, context, scenario_scopes)) {
            vayu::utils::log_error ("run", "script.setup failed",
            { { "runId", context->run_id },
            { "scriptError", vayu::utils::bounded_log_text (*setup_failure) } });
            context->is_running = false;
            context->join_aux_threads ();
            store_failed_run_summary (db, *context);
            db.transition_run_status (context->run_id,
            { vayu::RunStatus::Running }, vayu::RunStatus::Failed);
            manager.retain_run (context->run_id);
            return;
        }

        // Execute Load Strategy. One instant for both clocks: the report's
        // duration below and every elapsed figure the other threads publish.
        auto test_start = std::chrono::steady_clock::now ();
        const int64_t load_start_ms =
        std::chrono::duration_cast<std::chrono::milliseconds> (test_start.time_since_epoch ())
        .count ();
        context->load_start_steady_ms.store (load_start_ms);
        context->metrics_collector->set_load_start (load_start_ms);
        context->advance_phase (RunPhase::sending);
        std::shared_ptr<ScenarioLoadState> scenario_state;

        try {
            if (context->scenario) {
                scenario_state = execute_scenario_load (context, db, *context->scenario,
                vayu::utils::invariant_value (std::move (scenario_scopes),
                "a scenario run's setup loads its scopes"));
            } else {
                auto strategy = LoadStrategy::create (config);
                strategy->execute (context, db, request);
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error ("run", "Load test failed: " + std::string (e.what ()),
            { { "runId", context->run_id } });
            db.transition_run_status (context->run_id,
            { vayu::RunStatus::Running }, vayu::RunStatus::Failed);
            context->is_running = false;
            context->join_aux_threads ();
            manager.retain_run (context->run_id);
            return;
        }
        // Before the drain below, which sends nothing. From here a Stop no
        // longer decides the outcome; it only cuts the drain short.
        context->advance_phase (RunPhase::draining);
        const auto send_end                = std::chrono::steady_clock::now ();
        const size_t completed_at_send_end = context->total_requests ();

        // How the run lets go of the event loop depends on why it is ending.
        //
        // A Stop latched while sending must stop *sending*: draining the queued
        // backlog would keep the target under load after the stop, and waiting
        // on in-flight transfers hands the stop's latency to the upstream.
        // stop(false) discards the backlog and cancels what is in flight.
        //
        // The natural end lets genuine in-flight requests settle, but not
        // forever: one past its own bound (`natural_end_drain_ms`) will never
        // answer, and waiting on it pins the run in `running` with no way out.
        // A Stop during that drain cancels it (`request_stop`), whether it
        // reaches the loop before this stop() or while it blocks.
        //
        // Neither read is under event_loop_mtx, deliberately: this thread
        // published the pointer, so program order orders them, and stop()
        // blocks for the whole drain, during which the metrics thread must keep
        // ticking through active_transfer_count(), which takes that lock every
        // tick.
        if (context->stop_decides_outcome ()) {
            context->event_loop->stop (false);
        } else {
            // A collection run's streams are its steps' (#3235), beside the
            // ordinary steps its timeout bounds.
            const int64_t drain_ms = context->scenario ?
            collection_natural_end_drain_ms (
            longest_stream_bounds (context->scenario->plan), timeout_ms) :
            natural_end_drain_ms (context->stream_bounds, timeout_ms);
            context->event_loop->stop (true, std::chrono::milliseconds (drain_ms));
        }
        context->advance_phase (RunPhase::summarising);

        // Record test end time immediately (before cleanup overhead)
        auto test_end = std::chrono::steady_clock::now ();
        double total_duration_s =
        std::chrono::duration<double> (test_end - test_start).count ();
        const SendingWindow sending = sending_window (*context,
        std::chrono::duration<double> (send_end - test_start).count (),
        completed_at_send_end, total_duration_s);

        // The run's end, before the join and the summary below; the terminal
        // move in finish_load_test keeps it.
        db.update_run_end_time (context->run_id);

        // Stop background collection and wait for the threads to finish
        context->is_running = false;

        // Joined so the tick thread has finished writing to the DB, the refresh
        // watchdog has let go of it, and the scrape loop's `monitor_totals` is
        // final before the summary below reads it.
        context->join_aux_threads ();

        const auto cleanup_end = std::chrono::steady_clock::now ();
        const RunOverheads overheads{
            .setup_s = std::chrono::duration<double> (test_start - entry).count (),
            .cleanup_s = std::chrono::duration<double> (cleanup_end - test_end).count ()
        };

        finish_load_test (context, db, total_duration_s, sending, overheads,
        target_rps, request, scenario_state);
    } catch (const std::exception& e) {
        // Stop background metrics collection and join it, like the two inner
        // failure paths do. Deferring the join to ~RunContext instead would run
        // it under RunManager::mutex_ during a later sweep eviction.
        context->is_running = false;
        context->join_aux_threads ();

        vayu::utils::log_error ("run", "Load test error: " + std::string (e.what ()),
        { { "runId", context->run_id } });

        // A duration from load start, 0 if load never began.
        store_failed_run_summary (db, *context);

        // From Pending too: the throw may have come from the move to Running.
        try {
            db.transition_run_status (context->run_id,
            { vayu::RunStatus::Pending, vayu::RunStatus::Running },
            vayu::RunStatus::Failed);
        } catch (const std::exception& ex) {
            vayu::utils::log_error ("run",
            "Failed to update run status: " + std::string (ex.what ()),
            { { "runId", context->run_id } });
        }

        // Failed is terminal too - prune per the retention knobs, best-effort.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& ex) {
            vayu::utils::log_warning ("run",
            "Run pruning failed: " + std::string (ex.what ()),
            { { "runId", context->run_id } });
        }
    }

    context->is_running = false;
    manager.retain_run (context->run_id);
}

std::string build_tick_payload (const nlohmann::json& stats, size_t offset) {
    return build_sse_frame ("metrics", stats.dump (), offset);
}

namespace {

/// A window mean as JSON: `null` for a window that completed nothing.
nlohmann::json mean_or_null (const std::optional<double>& mean) {
    return mean ? nlohmann::json (*mean) : nlohmann::json (nullptr);
}

/// The summary's `phases`, keyed by wire name so a reader need not know the
/// enum's order. Each phase's `mean` is what the report's `avg*Ms` read
/// (#2782); a summary without it is an older run's, whose averages stay the
/// trace sample's.
nlohmann::json build_phases_summary_payload (
const std::array<MetricsCollector::Percentiles, TIMING_PHASE_COUNT>& measured,
const std::optional<std::array<double, TIMING_PHASE_COUNT>>& means) {
    nlohmann::json phases = nlohmann::json::object ();
    for (size_t i = 0; i < TIMING_PHASE_COUNT; ++i) {
        const auto& p        = measured.at (i);
        nlohmann::json phase = { { "p50", p.p50 }, { "p95", p.p95 },
            { "p99", p.p99 }, { "max", p.max }, { "count", p.count } };
        if (means) {
            phase["mean"] = means->at (i);
        }
        phases[TIMING_PHASE_KEYS.at (i)] = std::move (phase);
    }
    return phases;
}

/// The summed `error` of the element rows in @p rows: each a script that threw
/// or an element that could not run, once per execution.
size_t element_row_errors (const nlohmann::json& rows) {
    if (!rows.is_array ()) {
        return 0;
    }
    size_t errors = 0;
    for (const auto& row : rows) {
        const auto error = row.find ("error");
        if (error != row.end () && error->is_number_unsigned ()) {
            errors += error->get<size_t> ();
        }
    }
    return errors;
}

/// The element executions that ended in error, from the rows the summary
/// stores: a single-request run's top-level `elements`, a scenario load run's
/// `scenario.steps[].elements`. Not `scenario.errored`, which also counts a
/// step with no response (the error rate's subject). A deferred script's throw
/// is not here: the replay counts it in `tests.failed`.
size_t errored_element_runs (const RunSummaryInputs& inputs) {
    if (inputs.elements) {
        return element_row_errors (*inputs.elements);
    }
    if (!inputs.scenario) {
        return 0;
    }
    const auto steps = inputs.scenario->find ("steps");
    if (steps == inputs.scenario->end () || !steps->is_array ()) {
        return 0;
    }
    size_t errors = 0;
    for (const auto& step : *steps) {
        if (const auto rows = step.find ("elements"); rows != step.end ()) {
            errors += element_row_errors (*rows);
        }
    }
    return errors;
}

/// The `script.teardown` rows of `lifecycle` whose outcome failed or errored.
size_t failed_teardowns (const RunSummaryInputs& inputs) {
    if (!inputs.lifecycle) {
        return 0;
    }
    const auto teardown = inputs.lifecycle->find ("teardown");
    if (teardown == inputs.lifecycle->end () || !teardown->is_array ()) {
        return 0;
    }
    return static_cast<size_t> (
    std::ranges::count_if (*teardown, [] (const nlohmann::json& row) {
        const auto outcome = row.find ("outcome");
        return outcome != row.end () && (*outcome == "failed" || *outcome == "error");
    }));
}

nlohmann::json assertion_totals_payload (const AssertionTotals& totals) {
    return { { "passed", totals.passed }, { "failed", totals.failed } };
}

/// The summary's `assertions` block (#3537): everything a verdict reads as a
/// failed check, for both load run kinds. Absent when the run asserted nothing
/// and nothing errored; once present every member is written, so a zero is a
/// count, never an unrecorded figure.
std::optional<nlohmann::json> build_run_assertions_payload (const RunSummaryInputs& inputs) {
    const size_t errored         = errored_element_runs (inputs);
    const size_t teardown_failed = failed_teardowns (inputs);
    if (!inputs.assertions && errored == 0 && teardown_failed == 0) {
        return std::nullopt;
    }
    const auto populations = inputs.assertions.value_or (AssertionPopulations{});
    nlohmann::json block = { { "exact", assertion_totals_payload (populations.exact) },
        { "sampled", assertion_totals_payload (populations.sampled) },
        { "errored", errored }, { "teardownFailed", teardown_failed } };
    return std::optional<nlohmann::json> (std::in_place, std::move (block));
}

} // namespace

nlohmann::json build_metric_tick_payload (const MetricTickSample& sample) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : sample.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json payload;
    payload["timestamp"]            = sample.timestamp;
    payload["elapsed_seconds"]      = sample.elapsed_seconds;
    payload["requests_completed"]   = sample.requests_completed;
    payload["requests_failed"]      = sample.requests_failed;
    payload["http_errors"]          = sample.http_errors;
    payload["no_response"]          = sample.no_response;
    payload["cancelled"]            = sample.cancelled;
    payload["current_rps"]          = sample.current_rps;
    payload["current_send_rate"]    = sample.current_send_rate;
    payload["window_avg_in_flight"] = sample.window_avg_in_flight;
    payload["window_avg_latency_ms"] = mean_or_null (sample.window_avg_latency_ms);
    payload["window_avg_queue_wait_ms"] = mean_or_null (sample.window_avg_queue_wait_ms);
    payload["current_concurrency"] = sample.current_concurrency;
    payload["send_rate"]           = sample.send_rate;
    payload["throughput"]          = sample.throughput;
    payload["backpressure"]        = sample.backpressure;
    payload["error_rate"]          = sample.error_rate;
    payload["dropped_requests"]    = sample.dropped_requests;
    payload["skipped_requests"]    = sample.skipped_requests;
    payload["stalled_ms"]          = sample.stalled_ms;
    payload["bytes_sent"]          = sample.bytes_sent;
    payload["bytes_received"]      = sample.bytes_received;
    payload["status_codes"]        = codes;
    payload["status_seconds"] = status_seconds_json (sample.status_seconds);
    // Absent rather than null: the export schema types these as numbers.
    if (sample.latency_samples > 0) {
        payload["latency_p50_ms"] = sample.latency_p50_ms;
        payload["latency_p95_ms"] = sample.latency_p95_ms;
        payload["latency_p99_ms"] = sample.latency_p99_ms;
    }
    if (sample.custom_metrics.has_value ()) {
        payload["custom_metrics"] = build_custom_metrics_payload (*sample.custom_metrics);
    }
    return payload;
}

nlohmann::json build_run_summary_payload (const RunSummaryInputs& inputs) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : inputs.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json summary;
    summary["total_requests"] = inputs.total_requests;
    summary["cancelled"]      = inputs.cancelled;
    summary["rps"]            = inputs.rps;
    summary["send_rate"]      = inputs.send_rate;
    summary["throughput"]     = inputs.throughput;
    summary["test_duration"]  = inputs.test_duration_s;
    // Both always written: absent `cleanup_overhead` is a run stored before
    // #2894, whose `setup_overhead` held the cleanup figure.
    summary["setup_overhead"]   = inputs.setup_overhead_s;
    summary["cleanup_overhead"] = inputs.cleanup_overhead_s;
    summary["peak_concurrency"] = inputs.peak_concurrency;
    // Always written: absent is a run stored before #2821, whose report then
    // omits `avgInFlight` rather than claiming nothing was in flight.
    summary["avg_in_flight"]    = inputs.avg_in_flight;
    summary["dropped_requests"] = inputs.dropped_requests;
    // Always written, zeros included; absent is a run stored before #2911.
    summary["skipped_requests"] = inputs.skipped_requests;
    summary["stalled_ms"]       = inputs.stalled_ms;
    summary["queue_wait_avg"]   = inputs.queue_wait_avg_ms;
    summary["bytes_sent"]       = inputs.bytes_sent;
    summary["bytes_received"]   = inputs.bytes_received;
    // Always written, zeros included: the report reads an absent
    // `sending_duration` as a run stored before #2392 (old rate-fidelity
    // formula) and an absent `completed_while_sending` as one before #2882 (no
    // `completedWhileSending`).
    summary["requests_sent"]           = inputs.requests_sent;
    summary["requests_expected"]       = inputs.requests_expected;
    summary["sending_duration"]        = inputs.sending_duration_s;
    summary["completed_while_sending"] = inputs.completed_while_sending;
    // Always written, including the 0 case. An absent key means "an engine too
    // old to have looked", which apply_stored_summary must be able to tell from
    // "looked, and every request got the protocol it asked for".
    summary["http_version_downgraded"] = inputs.http_version_downgraded;
    summary["status_codes"]            = codes;
    // `count` is what a reader checks before trusting a percentile: a run that
    // timed no request still stores zeros here, which are not measurements.
    summary["latency"] = { { "count", inputs.latency.count },
        { "min", inputs.latency.min }, { "max", inputs.latency.max },
        { "avg", inputs.latency_avg_ms }, { "p50", inputs.latency.p50 },
        { "p75", inputs.latency.p75 }, { "p90", inputs.latency.p90 },
        { "p95", inputs.latency.p95 }, { "p99", inputs.latency.p99 },
        { "p999", inputs.latency.p999 } };
    // Always written, the downgrade's rule: absent is a run stored before
    // #2799, whose report then omits `connectionReplays`.
    summary["connection_replays"] = inputs.connection_replays;
    // Always written, `{}` included: an absent key is a run stored before
    // #2400, whose report still counts the stored error records by type.
    summary["error_types"] = nlohmann::json (inputs.error_types);
    // Always written, `{}` included: absent is a run stored before #3828,
    // whose report then leaves `summary.errorClasses` out rather than
    // claiming no reply failed.
    summary["error_classes"] = inputs.error_classes.to_json ();
    // What each bounded store thinned away. Always written: a reader that sees
    // the section and all zeros knows the stored set is complete, which a
    // missing section cannot say.
    summary["sampling"] = { { "errors_dropped", inputs.retention.errors_dropped },
        { "success_traces_dropped", inputs.retention.success_traces_dropped },
        { "slow_traces_dropped", inputs.retention.slow_traces_dropped },
        { "response_samples_dropped", inputs.retention.response_samples_dropped },
        { "exemplars_dropped", inputs.retention.exemplars_dropped },
        { "sample_bodies_dropped", inputs.retention.sample_bodies_dropped },
        // The run's own record that it captured response data verbatim, which
        // the Samples tab reads to warn about credentials. Persisted, not
        // re-derived: the tab renders from the report long after the collector
        // is gone.
        { "response_bodies_captured", inputs.retention.response_bodies_captured },
        // Which of the response-sample store's two bounds thinned it. The count
        // above says how much went unvalidated; this says whether what was kept
        // is still a uniform sample, the sentence the app's retention note
        // prints (#1192). Always written, so an absent key means an engine too
        // old to have looked, not a run that stayed uniform.
        { "response_sample_budget_spent", inputs.retention.response_sample_budget_spent } };
    // Present with a 0 count for a run that measured and found nothing slow;
    // absent where nothing measured (threshold 0) or the run predates #2399,
    // and the report then counts the stored traces instead.
    if (inputs.slow_threshold_ms > 0) {
        summary["slow_requests"] = { { "count", inputs.slow_total },
            { "thresholdMs", inputs.slow_threshold_ms } };
    }
    // Omitted entirely when validation did not run, so the report keeps
    // distinguishing "no test script" from "a script that passed nothing".
    if (inputs.tests.has_value ()) {
        summary["tests"] = test_totals_payload (*inputs.tests);
    }
    if (auto assertions = build_run_assertions_payload (inputs)) {
        summary["assertions"] = std::move (*assertions);
    }
    if (const auto& drain_cut = inputs.drain_cut) {
        summary["drainCut"] = { { "cancelled", *drain_cut } };
    }
    // The verdict against the run's declared budgets. Omitted when it declared
    // none, as `tests` is: "no budget" and "a budget nothing was measured
    // against" differ, and only an absent section says the first.
    if (inputs.thresholds.has_value ()) {
        summary["thresholds"] = build_threshold_outcome_payload (*inputs.thresholds);
    }
    // This run's `metric.record` / `pm.metrics` values (#1500), by name.
    // Omitted for a run that recorded none, as `tests` and `thresholds` are: an
    // empty object would read "measured and found nothing", not "never
    // declared".
    if (inputs.custom_metrics.has_value ()) {
        summary["customMetrics"] = build_custom_metrics_payload (*inputs.custom_metrics);
    }
    // Per-phase latency distributions. Omitted when the run recorded none - a
    // reader that finds no `phases` key is looking at a run whose phase data
    // was never collected, not at a target with a free TLS handshake.
    if (inputs.phases.has_value ()) {
        summary["phases"] =
        build_phases_summary_payload (*inputs.phases, inputs.phase_means);
    }
    // What a capacity run's search found, level by level. Omitted for every
    // other mode - a fixed-target run measured a point, not a curve, and has
    // no knee to report.
    if (inputs.capacity.has_value ()) {
        summary["capacity"] = build_capacity_summary_payload (*inputs.capacity);
    }
    // A scenario load run's sequence tallies, under the same key and in the
    // same shape the design-mode runner writes - one report section, two
    // executors. Omitted for a single-request load run, which has no sequence.
    if (inputs.scenario.has_value ()) {
        summary["scenario"] = *inputs.scenario;
    }
    // A single-request run's `requestElements` outcomes (#1594), the sibling of
    // `scenario` above: this shape has no steps to hang them off, so they sit
    // at the summary's top level. Omitted for every scenario run (whose
    // elements are in `scenario.steps[].elements`) and a single-request run
    // that declared none.
    if (inputs.elements.has_value () && !inputs.elements->empty ()) {
        summary["elements"] = *inputs.elements;
    }
    // Which of the bound contract's operations this run exercised (#629), in
    // the design-mode runner's shape. Omitted for every run not measured
    // against a contract (an unbound collection, a single-request load run, a
    // document stored before the operation index), so absence reads "not
    // measured", not a contract nothing covered.
    if (inputs.coverage.has_value () && !inputs.coverage->empty ()) {
        summary["coverage"] = *inputs.coverage;
    }
    // What the deferred pass over the *sampled* responses found against the
    // bound contract (#682). Omitted on `coverage`'s empty-is-absent terms for
    // every run that validated nothing, so absence reads "not checked", not a
    // contract nothing broke. Unlike `coverage`, these numbers describe the
    // samples: the block carries its own `sampled` denominator and the report
    // says so.
    if (inputs.schema_validation.has_value () && !inputs.schema_validation->empty ()) {
        summary["schemaValidation"] = *inputs.schema_validation;
    }
    // `script.setup` / `script.teardown` outcomes (#1499). Omitted for a run
    // whose collection declared neither, and for a single-request load run,
    // which has no collection to declare them on.
    if (inputs.lifecycle.has_value () && !inputs.lifecycle->empty ()) {
        summary["lifecycle"] = *inputs.lifecycle;
    }
    // What the server-vitals scrape recorded. Omitted for a run that configured
    // no monitor, so the report's section is absent rather than showing a run
    // that scraped nothing as one whose target reported zeros.
    if (inputs.monitor.has_value ()) {
        summary["monitor"] = *inputs.monitor;
    }
    // Whether this run's OAuth 2.0 credential was kept current, and at what
    // cost. Omitted for every run that could not refresh, so absence reads
    // "never watching", not "watched and saw nothing".
    if (inputs.auth.has_value ()) {
        summary["auth"] = *inputs.auth;
    }
    // What a streaming run's completions delivered (issue #576). Omitted for
    // every run that streamed nothing, so an absent section reads as "this run
    // was not a stream" rather than as a stream that carried no events.
    if (inputs.stream.has_value ()) {
        summary["stream"] =
        build_stream_summary_payload (*inputs.stream, inputs.test_duration_s);
    }
    // What this run did not do (#1503). Omitted for a run with nothing to
    // report, so the key's absence means "nothing to say" rather than every run
    // carrying an empty array.
    if (!inputs.warnings.empty ()) {
        summary["warnings"] = inputs.warnings;
    }
    return summary;
}

/**
 * A frame's trailing-window keys (#2393). A gate tick's stored row carries
 * the same reading under snake_case names, so the two cannot disagree.
 */
void put_window_reading (nlohmann::json& stats, const WindowReading& window) {
    stats["currentRps"]           = window.completed_per_s;
    stats["currentSendRate"]      = window.sent_per_s;
    stats["windowAvgInFlight"]    = window.avg_in_flight;
    stats["windowAvgLatencyMs"]   = mean_or_null (window.avg_latency_ms);
    stats["windowAvgQueueWaitMs"] = mean_or_null (window.avg_queue_wait_ms);
}

/// The counters a trailing window samples, at @p steady_ms. The sample count
/// is read before the sums, the order `average_latency` reads them in.
CumulativeCounters
cumulative_counters (const MetricsCollector& mc, int64_t steady_ms, size_t completed, size_t sent) {
    CumulativeCounters counters;
    counters.steady_ms            = steady_ms;
    counters.completed            = completed;
    counters.sent                 = sent;
    counters.latency_samples      = mc.latency_samples ();
    counters.latency_sum_ms       = mc.total_latency_sum ();
    counters.queue_wait_sum_ms    = mc.total_queue_wait_sum ();
    counters.inflight_integral_ms = mc.inflight_integral_ms (steady_ms);
    return counters;
}

/// Pushes this tick's counters into @p window and puts its reading on @p stats.
/// The completed and event counts are the frame's own (`totalRequests`,
/// `streamEvents`), so each rate is one reading with its total, and the
/// live-only `eventsPerSecond` (#3236) is on exactly the frames carrying
/// `streamEvents`.
WindowReading put_trailing_window (TrailingWindow& window,
const MetricsCollector& mc,
nlohmann::json& stats,
int64_t steady_ms,
size_t sent) {
    CumulativeCounters counters = cumulative_counters (
    mc, steady_ms, stats.at ("totalRequests").get<size_t> (), sent);
    const auto stream_events = stats.find ("streamEvents");
    const bool streams       = stream_events != stats.end ();
    if (streams) {
        counters.stream_events = stream_events->get<size_t> ();
    }
    const WindowReading reading = window.push (counters);
    put_window_reading (stats, reading);
    if (streams) {
        stats["eventsPerSecond"] = reading.events_per_s;
    }
    return reading;
}

/// What a gate tick hands the stored row: the second's merged percentiles, the
/// trailing window and the closed seconds' status classes its own frame
/// carries.
struct GateReadings {
    MetricsCollector::Percentiles second;
    WindowReading window;
    std::vector<StatusSecondEntry> status_seconds;
};

/**
 * One persisted metric tick: the 1 Hz row every chart is drawn from, one wide
 * row rather than ~18 EAV rows every reader reassembles. A dropped tick is a
 * hole in the history series that nothing downstream can tell from a quiet
 * second, so its reason is logged, not swallowed; it never fails the run, whose
 * live stream and final report come from the collector.
 *
 * A tick read at or before load start stores nothing (#2881): the series counts
 * from load start, as the live frames do. The stamp is compared with the tick's
 * own reading, not only with 0, because the worker can stamp it between that
 * reading and this call.
 */
void persist_metric_tick (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
int64_t tick_wall_ms,
int64_t tick_steady_ms,
const std::map<int, size_t>& status_snapshot,
const GateReadings& gate) {
    const int64_t load_start_steady_ms = context->load_start_steady_ms.load ();
    if (load_start_steady_ms == 0 || tick_steady_ms <= load_start_steady_ms) {
        return;
    }

    // The same snapshot the live tick counted from, total included (#3572), so
    // the stored row and the SSE frame for one tick cannot disagree.
    const auto failures        = vayu::count_status_failures (status_snapshot);
    const size_t current_total = failures.total;
    double error_rate          = failures.error_rate ();

    // Cumulative means since load start, beside the window's rates.
    size_t requests_sent = context->requests_sent.load ();
    const double run_elapsed_s = context->seconds_since_load_start (tick_steady_ms);
    double send_rate =
    run_elapsed_s > 0 ? static_cast<double> (requests_sent) / run_elapsed_s : 0.0;
    double throughput =
    run_elapsed_s > 0 ? static_cast<double> (current_total) / run_elapsed_s : 0.0;

    // Sent but not yet settled, plus the slots a think timer holds on a
    // single-request run (a scenario's timer waits are not in it).
    size_t backpressure = context->in_flight ();

    // One locked read for the debug line and the persisted row below, so both
    // report one instant. A run whose loop is not published yet (the runner
    // still in its config reads one second in) reports zero.
    const size_t active_now = context->active_transfer_count ();

    // The in-flight high-water mark: every load strategy updates it after each
    // submission batch (`update_peak` in load_strategy.cpp) and this 1 Hz
    // sample is the backstop. CAS-max so the two writers cannot clobber each
    // other.
    {
        size_t pk = context->peak_in_flight.load (std::memory_order_relaxed);
        while (backpressure > pk &&
        !context->peak_in_flight.compare_exchange_weak (
        pk, backpressure, std::memory_order_relaxed)) {
            // pk reloaded on failure
        }
    }

    vayu::utils::log_debug ("run", "Metrics",
    { { "runId", context->run_id }, { "rps", gate.window.completed_per_s },
    { "sendRate", send_rate }, { "throughput", throughput },
    { "backpressure", backpressure }, { "errorRate", error_rate },
    { "active", active_now }, { "sent", requests_sent } });

    // Persist the tick: one wide row, built here rather than
    // reassembled from ~18 EAV rows by every reader.
    try {
        auto& mc = *context->metrics_collector;
        MetricTickSample sample;
        sample.timestamp = tick_wall_ms;
        // The gate frame of this tick carries the same reading.
        sample.elapsed_seconds          = run_elapsed_s;
        sample.requests_completed       = current_total;
        sample.requests_failed          = failures.failed;
        sample.http_errors              = failures.http_errors ();
        sample.no_response              = failures.no_response;
        sample.cancelled                = mc.cancelled ();
        sample.current_rps              = gate.window.completed_per_s;
        sample.current_send_rate        = gate.window.sent_per_s;
        sample.window_avg_in_flight     = gate.window.avg_in_flight;
        sample.window_avg_latency_ms    = gate.window.avg_latency_ms;
        sample.window_avg_queue_wait_ms = gate.window.avg_queue_wait_ms;
        sample.current_concurrency      = active_now;
        sample.send_rate                = send_rate;
        sample.throughput               = throughput;
        sample.backpressure             = backpressure;
        sample.error_rate               = error_rate;
        sample.dropped_requests         = mc.dropped_requests ();
        sample.skipped_requests         = mc.skipped_requests ();
        sample.stalled_ms               = mc.stalled_ms ();
        sample.bytes_sent               = mc.total_bytes_sent ();
        sample.bytes_received           = mc.total_bytes_received ();
        // Reuse the snapshot already taken for the live tick above.
        sample.status_codes = status_snapshot;
        // The whole second's percentiles, every window since the previous row
        // merged (#2385), read by the history percentile chart, the
        // response-time-vs-concurrency scatter and the breakpoint / saturation
        // derivations. This tick's gate frame carries the same figures as
        // `second*`.
        sample.latency_samples = gate.second.count;
        sample.latency_p50_ms  = gate.second.p50;
        sample.latency_p95_ms  = gate.second.p95;
        sample.latency_p99_ms  = gate.second.p99;
        sample.status_seconds  = gate.status_seconds;
        sample.custom_metrics  = mc.custom_metric_summaries ();

        db.add_metric_tick ({ 0, context->run_id, tick_wall_ms,
        build_metric_tick_payload (sample).dump () });
    } catch (const std::exception& e) {
        // Logged, never fatal (the docblock says why); at most one line per
        // tick, and the tick gate is 1 Hz.
        vayu::utils::log_warning ("run",
        "Metric tick not persisted: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }
}

namespace {

/// A capacity run's live `capacity` block (#2928). Level 0 means no level has
/// opened, with a time in level of 0. Once the search ends the time stops at
/// the end and `stopReason` appears; it is absent while the search runs.
nlohmann::json capacity_progress_json (const RunContext::CapacityProgress& progress,
int64_t now_steady_ms) {
    int64_t level_elapsed_ms = 0;
    if (progress.level != 0) {
        const int64_t until =
        progress.ended_steady_ms != 0 ? progress.ended_steady_ms : now_steady_ms;
        // The tick can read its clock just before the search opens a level.
        level_elapsed_ms =
        std::max<int64_t> (until - progress.level_started_steady_ms, 0);
    }
    nlohmann::json block = { { "level", progress.level },
        { "levelElapsedMs", level_elapsed_ms },
        { "levelsJudged", progress.levels_judged } };
    if (progress.stop_reason != nullptr) {
        block["stopReason"] = progress.stop_reason;
    }
    return block;
}

} // namespace

void collect_metrics (std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr) {
    auto& db = *db_ptr;
    // Read once: the mode is fixed for the run, and the block is absent from
    // every other run's frames rather than zeroed.
    const bool capacity_run = runs_capacity_search (context->config);
    auto last_update        = std::chrono::steady_clock::now ();

    // The frame's and the stored row's rates and window means.
    TrailingWindow rate_window (constants::server::LIVE_RATE_WINDOW_MS);

    // LiveTick::current_rps, the capacity search's rate: a delta over at
    // least 100 ms, refreshed when that much has passed.
    auto rps_last_time    = std::chrono::steady_clock::now ();
    size_t rps_last_total = 0;
    double interval_rps   = 0.0;
    bool rps_first        = true;

    // Live tick cadence (default 100 ms); DB write still gated at 1 Hz.
    // Declared here so it is in scope inside the try block below.
    int tick_interval_ms = 0;

    // Builds and appends one SSE "metrics" event to the in-memory tick topic,
    // field-for-field the SSE handler's (metrics.cpp). The caller passes the
    // wall-clock timestamp so the SSE tick and any persisted enrichment of the
    // same tick share it: re-sampling now_ms() inside drifts them into adjacent
    // ms buckets and the dashboard sees status codes shift left of throughput
    // on one x-axis.
    //
    // A tick that `closes_second` is a gate: it takes the second's merged
    // percentiles, puts them on its frame and returns them, with the frame's
    // trailing window, for the stored row, so a tick's frame and row cannot
    // disagree. Only a gate frame carries the run-so-far distributions (#2782)
    // and a scenario load's sequence so far (#2823), so the 100 ms frames stay
    // their size. Every other tick returns nullopt and leaves the second open.
    auto emit_live_tick = [&] (const std::map<int, size_t>* status_snapshot,
                          int64_t now_wall_ms, int64_t now_steady_ms,
                          bool closes_second) -> std::optional<GateReadings> {
        auto& mc                 = *context->metrics_collector;
        size_t active_count      = context->active_transfer_count ();
        size_t requests_sent     = context->requests_sent.load ();
        size_t requests_expected = context->requests_expected.load ();
        double elapsed_seconds = context->seconds_since_load_start (now_steady_ms);

        // One distribution for the frame's error counts and the level's, so
        // the capacity search judges a level's errors as the frame reports them.
        std::map<int, size_t> own_snapshot;
        const std::map<int, size_t>& statuses = status_snapshot != nullptr ?
        *status_snapshot :
        (own_snapshot = mc.status_code_distribution ());

        // Before the sample, so a level the capacity search opened since the
        // previous tick starts with this tick's window.
        mc.adopt_level_epoch (context->requested_level_epoch (), statuses);
        // Exactly once per tick: it resets the window on read, and folds the
        // window into the open second before that.
        auto window = mc.sample_window_percentiles ();

        auto stats = mc.get_current_stats (active_count, elapsed_seconds,
        requests_sent, requests_expected, &statuses, &window);

        size_t current_total = stats["totalRequests"].get<size_t> ();
        const WindowReading rates =
        put_trailing_window (rate_window, mc, stats, now_steady_ms, requests_sent);

        std::optional<GateReadings> gate;
        if (closes_second) {
            // Drained once, here, so the frame and the row hold the same
            // seconds and a second is never emitted twice.
            gate = GateReadings{ mc.take_second_percentiles (), rates,
                mc.drain_status_seconds (now_steady_ms) };
            put_interval_percentiles (stats, "second", gate->second);
            mc.put_gate_distributions (stats);
            stats["statusSeconds"] = status_seconds_json (gate->status_seconds);
            if (const auto scenario = context->published_scenario_state ()) {
                stats["scenario"] = build_scenario_live_progress (*scenario);
            }
        }

        auto now_steady = std::chrono::steady_clock::now ();
        if (rps_first) {
            rps_last_total = current_total;
            rps_last_time  = now_steady;
            rps_first      = false;
        } else {
            double iv =
            std::chrono::duration<double> (now_steady - rps_last_time).count ();
            if (iv >= 0.1) {
                interval_rps = static_cast<double> (current_total - rps_last_total) / iv;
                rps_last_total = current_total;
                rps_last_time  = now_steady;
            }
        }

        // One definition with the persisted tick and peak_in_flight: a
        // single-request run's think-timer reservations included (#1921; a
        // scenario's timer waits are not, #2821), Stop-cancelled requests
        // excluded (#2136), so it can differ from this frame's
        // `requestsSent - totalRequests`.
        const size_t backpressure = context->in_flight ();
        stats["backpressure"]     = backpressure;
        // Beside `backpressure` so a client can tell transfers still being
        // sent from ones a natural-end drain is waiting out (#3568).
        stats["phase"]            = to_string (context->phase ());
        stats["runId"]            = context->run_id;
        stats["timestamp"]        = now_wall_ms;
        stats["requestsSent"]     = requests_sent;
        stats["requestsExpected"] = requests_expected;
        if (capacity_run) {
            stats["capacity"] =
            capacity_progress_json (context->capacity_progress (), now_steady_ms);
        }

        // Publish the same numbers to the strategies' feedback path, before
        // the SSE payload rather than after: a capacity search polls this every
        // tick, and the serialize-and-append below is the slower half.
        context->publish_live_tick (
        { 0, interval_rps, backpressure, mc.level_latency (statuses) });

        // Framed by the ring, which assigns the id under its own lock: a run
        // with a monitor has a second producer appending to it, and reading the
        // offset here would race that thread for the same id.
        context->append_event ("metrics", stats.dump ());
        return gate;
    };

    // Any exception (std::bad_alloc, a json error) is caught here rather than
    // escaping the thread function into std::terminate. `context->closed` is
    // set unconditionally after the try/catch, so attached /runs/:id/live
    // consumers always end cleanly.
    try {
        tick_interval_ms = db_ptr->get_config_int (
        "liveTickIntervalMs", vayu::core::constants::server::STATS_INTERVAL_MS);

        // The replay ring sized from the configured window and this run's tick
        // cadence, so it retains the *duration* the user asked for, not a tick
        // count whose span varies by cadence. Read once: changing the window
        // mid-run would make the ids the dashboard holds refer to a
        // differently-sized window.
        context->set_max_live_ticks (
        live_ring_size (db_ptr->get_config_int ("liveReplayWindowMs",
                        vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS),
        tick_interval_ms,
        static_cast<size_t> (db_ptr->get_config_int ("liveMaxRetainedTicks",
        static_cast<int> (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS)))));

        // Tick 0: emit immediately so consumers see data before the first sleep.
        (void)emit_live_tick (nullptr, now_ms (), steady_now_ms (), false);

        // Loops on is_running alone. should_stop is only the *request*: the
        // worker acts on it, blocks in event_loop->stop (cancelling on a user
        // stop, draining to a deadline at the natural end) and clears
        // is_running after. Exiting on should_stop would emit the "final
        // settled tick" and set closed while hundreds of requests still
        // settled, freezing the live view at the stop click while the stored
        // report, written after the worker returned, counted everything that
        // landed in between.
        while (context->is_running) {
            std::this_thread::sleep_for (std::chrono::milliseconds (tick_interval_ms));

            // One sample of each clock per tick: the wall one for the SSE
            // payload timestamp and (on DB-gated ticks) every persisted metric
            // row below (#27); the monotonic one for every elapsed figure of
            // the tick, so both are one logical instant with no duration on
            // wall time.
            int64_t tick_wall_ms   = now_ms ();
            int64_t tick_steady_ms = steady_now_ms ();

            // One status-code snapshot per tick, shared by the SSE builder and
            // (on DB-gated ticks) the persisted enrichment builder, so the map
            // is scanned and copied once.
            auto status_snapshot = context->metrics_collector->status_code_distribution ();

            // The 1 Hz DB gate is decided before the live tick, so the gate
            // tick's frame carries the same second the stored row does.
            auto now = std::chrono::steady_clock::now ();
            auto elapsed = std::chrono::duration<double> (now - last_update).count ();

            // A live tick every iteration; a gate tick also closes the second,
            // whether or not the row below persists. A gate storing nothing
            // (setup still running) still restarts the second, or every later
            // tick would be a gate.
            const auto gate = emit_live_tick (
            &status_snapshot, tick_wall_ms, tick_steady_ms, elapsed >= 1.0);
            if (gate) {
                persist_metric_tick (context, db, tick_wall_ms, tick_steady_ms,
                status_snapshot, *gate);
                last_update = now;
            }
        }

        // The final settled tick before signalling closed: consumers rely on
        // that order as the termination contract (last data, then
        // closed==true). It closes the partial second since the last gate on
        // the live frame only, storing no row, so the stored series keeps whole
        // seconds. Its `statusSeconds` are the seconds closed since that gate,
        // which only this frame carries; the still-open last second is emitted
        // nowhere.
        (void)emit_live_tick (nullptr, now_ms (), steady_now_ms (), true);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "collect_metrics: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    } catch (...) {
        vayu::utils::log_error ("run", "collect_metrics: unknown exception",
        { { "runId", context->run_id } });
    }

    // Unconditional: always signal consumers so they terminate cleanly,
    // even if the producer threw.
    context->closed.store (true, std::memory_order_release);
}

/// A scrape with no 2xx answer: the URL or the endpoint is at fault. Nothing is
/// stored, since a sample with no readings would draw a line through a hole in
/// the data. Logged once, on the failure that backs the loop off.
void note_monitor_failure (const std::shared_ptr<RunContext>& context,
const MonitorConfig& config,
std::string cause,
MonitorBackoff& backoff) {
    const bool was_backed_off = std::holds_alternative<MonitorBackedOff> (backoff);
    backoff = after_scrape_failure (backoff);
    if (!was_backed_off && std::holds_alternative<MonitorBackedOff> (backoff)) {
        vayu::utils::log_warning ("run",
        "Monitor endpoint failed " + std::to_string (constants::monitor::FAILURES_BEFORE_BACKOFF) +
        " scrapes in a row; backing off, the series will show gaps",
        { { "runId", context->run_id }, { "monitorUrl", config.url }, { "cause", cause } });
    }
    if (context->monitor_totals) {
        context->monitor_totals->record_failure (std::move (cause));
    }
}

/// A 2xx scrape carrying none of the requested names: the endpoint is healthy
/// and the names are at fault (#3120), so it is counted apart from a failure
/// and does not back off. Like a failure, it stores and publishes nothing.
void note_monitor_no_match (const std::shared_ptr<RunContext>& context) {
    if (context->monitor_totals) {
        context->monitor_totals->record_no_match ();
    }
}

/** A scrape that read values: stored and published. */
void record_monitor_sample (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const std::map<std::string, double>& values) {
    const int64_t sample_wall_ms = now_ms ();
    auto payload = build_monitor_sample_payload (sample_wall_ms, values);
    if (context->monitor_totals) {
        context->monitor_totals->add (values);
    }
    try {
        db.add_monitor_sample ({ 0, context->run_id, sample_wall_ms, payload.dump () });
    } catch (const std::exception& e) {
        // The live frame below still goes out: a row this run could
        // not store is worth less than a series that stops drawing.
        vayu::utils::log_warning ("run",
        "Failed to store monitor sample: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }
    context->append_event ("monitor", payload.dump ());
}

void collect_monitor (const std::shared_ptr<RunContext>& context,
vayu::db::Database* db_ptr,
const MonitorConfig& config) {
    auto& db = *db_ptr;

    // A scrape must not outlive its cadence: a late answer's sample is no
    // longer about the moment asked for, and the loop would spend the run
    // behind itself. Derived from the interval unless `monitorScrapeTimeoutMs`
    // says otherwise, since an exposition slower to render than the derivation
    // allows would fail every scrape, and slowing the cadence would thin the
    // data.
    const int timeout_ms =
    resolve_scrape_timeout_ms (config.interval_ms, config.scrape_timeout_ms);
    if (config.scrape_timeout_ms > timeout_ms) {
        // Said once, at the top: the setting is engine-wide but the cap is
        // *this* block's interval, so a value fine for a slow run is shortened
        // on a fast one, and silence would look like the setting had not taken.
        vayu::utils::log_warning ("run",
        "Monitor scrape timeout capped at the scrape interval (" +
        std::to_string (timeout_ms) + "ms); 'monitorScrapeTimeoutMs' is " +
        std::to_string (config.scrape_timeout_ms) + "ms, which is longer than this run's " +
        std::to_string (config.interval_ms) + "ms cadence",
        { { "runId", context->run_id } });
    }

    // No cookie jar: the engine talks on its own behalf, like the OAuth token
    // call and the update check (ClientConfig::cookie_jar). The proxy still
    // applies: a vitals endpoint inside a corporate network is reached like
    // everything else (#705). Resolved once, like the scrape cadence, because
    // the loop runs for the length of the run.
    vayu::http::ClientConfig monitor_client_config;
    monitor_client_config.transport = vayu::http::resolve_transport_policy (db);
    monitor_client_config.cancel    = &context->aux_cancel;
    vayu::http::Client client{ monitor_client_config };

    MonitorBackoff backoff = MonitorHealthy{};

    // Guarded whole, for the same reason collect_metrics is: an exception out
    // of a thread function calls std::terminate, and a scrape failure must
    // never take the run with it.
    try {
        while (context->is_running) {
            const auto scrape_started = std::chrono::steady_clock::now ();

            vayu::Request request;
            request.method     = vayu::HttpMethod::GET;
            request.url        = config.url;
            request.timeout_ms = timeout_ms;

            const auto sent = client.send (request);
            if (scrape_cancelled (sent)) {
                break; // The run ended under it, which says nothing about the endpoint.
            }
            if (auto cause = scrape_failure_cause (sent)) {
                note_monitor_failure (context, config, std::move (*cause), backoff);
            } else {
                backoff = MonitorHealthy{};
                const auto values =
                parse_monitor_body (config.format, sent.value ().body, config.series);
                if (values.empty ()) {
                    note_monitor_no_match (context);
                } else {
                    record_monitor_sample (context, db, values);
                }
            }

            // Sleep out the remainder of the interval in short slices. A run
            // that finishes joins this thread, so a single sleep_for would hold
            // the whole run open for up to a minute at the maximum interval.
            const int interval_ms = scrape_interval_ms (backoff, config.interval_ms);
            const auto deadline = scrape_started + std::chrono::milliseconds (interval_ms);
            while (context->is_running && std::chrono::steady_clock::now () < deadline) {
                std::this_thread::sleep_for (
                std::chrono::milliseconds (std::min (50, interval_ms)));
            }
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "collect_monitor: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    } catch (...) {
        vayu::utils::log_error ("run", "collect_monitor: unknown exception",
        { { "runId", context->run_id } });
    }
}

} // namespace vayu::core
