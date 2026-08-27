/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <chrono>
#include <iostream>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// Snapshot what each bounded store thinned away, for the run summary. One
/// copy so the completed-run and crashed-run summaries cannot report retention
/// differently.
SamplingRetention read_retention (const MetricsCollector& mc) {
    SamplingRetention retention;
    retention.errors_dropped           = mc.errors_dropped ();
    retention.success_traces_dropped   = mc.success_results_dropped ();
    retention.slow_traces_dropped      = mc.slow_results_dropped ();
    retention.response_samples_dropped = mc.response_samples_dropped ();
    retention.exemplars_dropped        = mc.exemplar_results_dropped ();
    retention.sample_bodies_dropped    = mc.sample_bodies_dropped ();
    retention.response_bodies_captured = mc.response_bodies_captured ();
    return retention;
}

/**
 * @brief One deferred replay: a script, the samples it runs against, and the
 *        identity `pm.info` reports while it does.
 *
 * A single-request run builds exactly one of these; a scenario load run builds
 * one per scripted step, which is the whole of the per-step extension - the
 * replay itself is the same code either way, so the two shapes cannot drift
 * into reporting a pass differently.
 */
struct ScriptReplay {
    const std::string* script                  = nullptr;
    const vayu::Request* request               = nullptr;
    const std::vector<ResponseSample>* samples = nullptr;
    /// The run's data rows, so a sampled iteration reads the row it was bound
    /// to as `pm.iterationData`. Null for a run sent without `data`.
    const std::vector<nlohmann::json>* data_rows = nullptr;
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    /// Prefixed to every failure message so a scenario's failures name their
    /// step. Empty for a single-request run, whose failures need no qualifier.
    std::string failure_prefix;
    /// The caps a streamed sample's events are parsed back under (issue #657).
    /// Read once for the run, like `SseStreamRequest::limits` is read once for
    /// a stream: every sample in one run is then bounded by one rule rather
    /// than by whatever the settings said when each replay reached it.
    vayu::http::SseLimits sse_limits;
};

/**
 * @brief Replay one script against one set of samples, tallying the results.
 *
 * @param scopes The run's stored variable scopes, shared by every replay of the
 *        pass and mutated in place by any `set()` a script performs - see
 *        `validate_scripts` for why those writes are never persisted.
 * @param failure_messages Appended to, bounded by MAX_FAILURE_MESSAGES across
 *        the whole run - a forty-step plan must not multiply the cap by forty.
 */
ScriptValidationTotals run_replay (vayu::runtime::ScriptEngine& engine,
vayu::http::routes::ScriptVariableScopes& scopes,
const ScriptReplay& replay,
std::vector<std::string>& failure_messages) {
    ScriptValidationTotals totals;
    totals.sampled = replay.samples->size ();

    auto record_failure = [&failure_messages, &replay] (const std::string& message) {
        if (failure_messages.size () <
        vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
            failure_messages.push_back (replay.failure_prefix + message);
        }
    };

    for (const auto& sample : *replay.samples) {
        // Build Response from sample
        vayu::Response response;
        response.status_code     = sample.status_code;
        response.status_text     = sample.status_text;
        response.body            = sample.body;
        response.headers         = sample.headers;
        response.timing.total_ms = sample.latency_ms;

        try {
            auto script_ctx =
            vayu::runtime::ScriptContext::for_test (*replay.request, response);
            // All four scopes, through the one function that knows which of
            // them a script may write (issue #728). Binding only `environment`
            // here - and an empty one at that - is what made the same test
            // script pass on Send and fail on every replay.
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            script_ctx.request_id   = replay.request_id;
            script_ctx.request_name = replay.request_name;
            // The iteration this response was actually sent in and the virtual
            // user that sent it, both claimed on the submission path before the
            // send (issue #994) - which is what keeps issue #300's ruling
            // intact rather than reopening it: what that ruling refuses is
            // reporting a *reservoir position* as an iteration number, and
            // neither of these is one. `iterationCount` stays absent even here
            // - a duration-bounded run has no total to report, and a script
            // that could read it from one mode and not the other is worse than
            // one that never reads it.
            script_ctx.iteration = sample.iteration;
            script_ctx.vu        = sample.vu;
            if (replay.data_rows != nullptr && sample.data_row_index &&
            *sample.data_row_index < replay.data_rows->size ()) {
                script_ctx.iteration_data = &(*replay.data_rows)[*sample.data_row_index];
            }
            // `pm.response.events` for a sampled stream (issue #657). Parsed
            // here, at the end of the run, rather than copied on the completion
            // path: the body already is the event list, and the deferred pass
            // is where the expensive half of sampling belongs. A sample that
            // did not stream sets nothing, so the script reads `undefined` -
            // the same absent-not-empty rule the live path keeps.
            //
            // Declared in the loop so the node outlives the execute it is bound
            // to and no longer.
            nlohmann::json stream_events;
            if (sample.stream_events) {
                stream_events = vayu::http::buffered_stream_events_node (sample.body,
                replay.sse_limits, static_cast<int64_t> (*sample.stream_events),
                // A load sample keeps the whole body it captured: the reservoir
                // copies `Response::body`, which the byte cap has already ended
                // the transfer over if it was ever exceeded. `CapturedExchange`
                // is the path that truncates, and it is not this one.
                true);
                script_ctx.response_events = &stream_events;
            }
            auto result = engine.execute (*replay.script, script_ctx);

            if (result.success) {
                // Check individual test results
                for (const auto& test : result.tests) {
                    if (test.passed) {
                        totals.passed++;
                    } else {
                        totals.failed++;
                        record_failure (test.name + ": " + test.error_message);
                    }
                }
                if (result.tests.empty ()) {
                    // Script ran but had no pm.test() calls - count as passed
                    totals.passed++;
                }
            } else {
                totals.failed++;
                record_failure ("Script error: " + result.error_message);
            }
        } catch (const std::exception& e) {
            totals.failed++;
            record_failure ("Exception: " + std::string (e.what ()));
        }
    }

    return totals;
}
} // namespace

/**
 * The run-level request and identity a single-request replay reads.
 *
 * A load run's `tests` script is the same script a Send runs, so it must not
 * read `pm.info.requestId` as undefined here and as a value there. Both fields
 * ride in on the composed payload for a run started from a saved request;
 * resolved once, not per sample. The linked row is read once for the two
 * readers below it: the `pm.info.requestName` fallback, and the collection scope
 * its scripts read (issue #728) - a failure is left to propagate, because empty
 * scopes are the silently wrong verdicts this pass exists to avoid.
 */
void read_run_script_identity (vayu::db::Database& db,
const nlohmann::json& config,
vayu::Request& dummy_request,
std::optional<std::string>& script_request_id,
std::optional<std::string>& script_request_name,
std::optional<vayu::db::Request>& linked_request) {
    // Build a dummy request for script context (HTTP request fields are at root level)
    auto request_result = vayu::json::deserialize_request (config);
    if (request_result.is_ok ()) {
        dummy_request = request_result.value ();
    }

    // Identity for `pm.info`. A load run's `tests` script is the same script a
    // Send runs, so it must not read `pm.info.requestId` as undefined here and
    // as a value there. Both fields ride in on the composed payload for a run
    // started from a saved request; resolved once, not per sample.
    if (auto id = config.find ("requestId");
    id != config.end () && id->is_string () && !id->get<std::string> ().empty ()) {
        script_request_id = id->get<std::string> ();
    }
    // The linked request row, read once for the two readers below: the
    // `pm.info.requestName` fallback, and the collection scope its scripts
    // read (issue #728). The lookup used to be wrapped in a catch, on the
    // grounds that it cost the script only a name - it now also decides
    // which collection scope the replay binds, and empty scopes are the
    // silently wrong verdicts this pass exists to avoid, so a failure is
    // left to propagate (see the scopes note below).
    if (script_request_id) {
        linked_request = db.get_request (*script_request_id);
    }

    if (auto name = config.find ("requestName"); name != config.end () &&
    name->is_string () && !name->get<std::string> ().empty ()) {
        script_request_name = name->get<std::string> ();
    } else if (linked_request && !linked_request->name.empty ()) {
        script_request_name = linked_request->name;
    }
}

/**
 * The per-step replays of a scenario load run.
 *
 * A step with no script, or one whose script never got a sample to run against,
 * reports nothing rather than a row of zeros - the same distinction the
 * whole-run section has always kept.
 */
ScriptValidationTotals replay_scenario_steps (vayu::runtime::ScriptEngine& engine,
vayu::http::routes::ScriptVariableScopes& scopes,
const std::shared_ptr<RunContext>& context,
const vayu::http::SseLimits& sse_limits,
bool verbose,
ScriptValidation& validation,
std::vector<std::string>& failure_messages) {
    ScriptValidationTotals run_totals;
    const auto& plan      = context->scenario->plan;
    const auto& data_rows = context->scenario->data_rows;
    const size_t steps    = std::min (
    plan.steps.size (), context->metrics_collector->step_sample_step_count ());
    validation.steps.resize (steps);

    for (size_t i = 0; i < steps; ++i) {
        const auto& step = plan.steps[i];
        const auto& samples = context->metrics_collector->step_response_samples (i);
        // A step with no script, or one whose script never got a sample to
        // run against, reports nothing rather than a row of zeros - the
        // same distinction the whole-run section has always kept.
        if (step.post_script.empty () || samples.empty ()) {
            continue;
        }

        if (verbose) {
            vayu::utils::log_info ("Validating " +
            std::to_string (samples.size ()) + " response samples for step " +
            std::to_string (i + 1) + " (" + step.name + ")...");
        }

        ScriptReplay replay;
        replay.script = &step.post_script;
        // The step's own request, so `pm.request` describes the step the
        // script is asserting on rather than a run-level request a
        // scenario payload does not have.
        replay.request    = &step.request;
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

        const auto totals = run_replay (engine, scopes, replay, failure_messages);
        validation.steps[i] = totals;
        run_totals.sampled += totals.sampled;
        run_totals.passed += totals.passed;
        run_totals.failed += totals.failed;
    }

    // Every scripted step drew a blank, so the run validated nothing.
    if (run_totals.sampled == 0) {
        return run_totals;
    }
    return run_totals;
}

/** The failure summary this pass leaves behind as a result row. */
void store_validation_failures (vayu::db::Database& db,
const std::string& run_id,
const std::vector<std::string>& failure_messages,
size_t passed,
size_t failed) {
    // Store failure summary as a result record
    auto timestamp = now_ms ();
    if (!failure_messages.empty ()) {
        nlohmann::json failure_json;
        failure_json["failures"]    = failure_messages;
        failure_json["totalFailed"] = failed;
        failure_json["totalPassed"] = passed;

        vayu::db::Result validation_result;
        validation_result.run_id    = run_id;
        validation_result.timestamp = timestamp;
        validation_result.status_code = failed > 0 ? 0 : 200; // 0 indicates test failures
        validation_result.latency_ms = 0;
        validation_result.error = failed > 0 ? "Script validation failures" : "";
        validation_result.trace_data = failure_json.dump ();

        db.add_result (validation_result);
    }
}

ScriptValidation validate_scripts (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
bool verbose) {
    ScriptValidation validation;

    // Which shape this run is. A scenario load run's scripts hang off its plan
    // steps; a single-request run has the one run-level script. The step stores
    // exist only where the executor sized them, so their presence is the test
    // rather than a second flag that could disagree with them.
    const bool per_step = context->scenario != nullptr &&
    context->metrics_collector->step_sample_step_count () > 0;

    if (!per_step && context->test_script.empty ()) {
        return validation; // No script to validate
    }

    if (!per_step && context->metrics_collector->response_samples ().empty ()) {
        if (verbose) {
            vayu::utils::log_info (
            "No response samples collected for script validation");
        }
        return validation;
    }

    // Create script engine for validation, bounded by the same timeout/limits
    // the execute path reads so an infinite-loop test script cannot spin the
    // run's worker thread forever.
    vayu::runtime::ScriptConfig script_config;
    script_config.timeout_ms     = static_cast<uint64_t> (db.get_config_int (
    "scriptTimeout", vayu::core::constants::script_engine::TIMEOUT_MS));
    script_config.memory_limit   = static_cast<size_t> (db.get_config_int (
    "scriptMemoryLimit", vayu::core::constants::script_engine::MEMORY_LIMIT));
    script_config.stack_size     = static_cast<size_t> (db.get_config_int (
    "scriptStackSize", vayu::core::constants::script_engine::STACK_SIZE));
    script_config.enable_console = db.get_config_bool (
    "scriptEnableConsole", vayu::core::constants::script_engine::ENABLE_CONSOLE);
    // Read off the run's own payload, through the same reader `POST /execute`
    // uses. The `tests` script here is the same script a Send runs, so it must
    // not have pm.sendRequest in one and not the other - and a run's script
    // runs once per *sampled* response, which is what the per-script request
    // cap is there to bound.
    script_config.allow_send_request =
    vayu::http::read_allow_script_requests (context->config);

    vayu::runtime::ScriptEngine engine (script_config);
    // One read for the whole pass, shared by every replay it drives.
    const vayu::http::SseLimits sse_limits = vayu::http::read_sse_limits (db);

    // The run-level request and identity, for the single-request shape. A
    // scenario takes both off the plan step it is replaying instead, so it does
    // not pay for a payload lookup whose answer it would discard.
    vayu::Request dummy_request;
    std::optional<std::string> script_request_id;
    std::optional<std::string> script_request_name;
    std::optional<vayu::db::Request> linked_request;
    if (!per_step) {
        read_run_script_identity (db, context->config, dummy_request,
        script_request_id, script_request_name, linked_request);
    }

    // The scopes the replayed scripts read (issue #728). A load run's `tests`
    // script is the same script a Send runs, so `pm.environment.get('region')`
    // must answer the same here as it does there - before this, every replay
    // read an empty environment and no globals or collection scope at all, so a
    // test comparing a response against a variable failed on every sample and
    // reported the target as broken.
    //
    // Which collection scope is the run's is the same question the two
    // sequential paths answer: a scenario run's is the collection being run
    // (`scenario_runner.cpp`), a single-request run's is the collection of the
    // request it links (`load_script_variable_scopes(db, run)`). Read off the
    // payload, which is what the run row itself was populated from, and where
    // this function already reads `requestId` from.
    //
    // A database failure here is deliberately not caught: it propagates to
    // `execute_load_test`, which logs it and stores no `testValidation`
    // section. Tallies computed against scopes that failed to load would be
    // the silently wrong verdicts this issue is about, and "never judged" must
    // not be reported as "judged and passed".
    std::optional<std::string> environment_id;
    if (auto it = context->config.find ("environmentId"); it != context->config.end () &&
    it->is_string () && !it->get<std::string> ().empty ()) {
        environment_id = it->get<std::string> ();
    }

    std::string collection_id;
    if (per_step) {
        collection_id = context->scenario->request.collection_id;
    } else if (linked_request) {
        collection_id = linked_request->collection_id;
    }

    // Loaded once and shared by every replay of the pass, so a `set()` is
    // readable by the samples replayed after it - the same within-a-run
    // visibility a sequential run gives. Never persisted:
    // `persist_script_variables` is design-mode only, and a reservoir sample is
    // not an iteration, so writing back whichever replay ran last would store a
    // value no ordering justifies.
    auto scopes = vayu::http::routes::load_script_variable_scopes (
    db, environment_id, collection_id);

    size_t passed  = 0;
    size_t failed  = 0;
    size_t sampled = 0;
    std::vector<std::string> failure_messages;

    if (per_step) {
        const ScriptValidationTotals totals = replay_scenario_steps (engine,
        scopes, context, sse_limits, verbose, validation, failure_messages);
        sampled                             = totals.sampled;
        passed                              = totals.passed;
        failed                              = totals.failed;
        // Every scripted step drew a blank, so the run validated nothing.
        if (sampled == 0) {
            return validation;
        }
    } else {
        const auto& samples = context->metrics_collector->response_samples ();
        if (verbose) {
            vayu::utils::log_info ("Validating " + std::to_string (samples.size ()) +
            " response samples with test script...");
        }

        ScriptReplay replay;
        replay.script  = &context->test_script;
        replay.request = &dummy_request;
        replay.samples = &samples;
        // The rows this run bound, so a sampled submission reads the row it
        // actually carried as `pm.iterationData` - the same reading a scenario
        // step's replay gets, off the row index the sample was stamped with
        // (issue #993). Null for a run sent without rows, which is what keeps
        // `pm.iterationData` `undefined` there.
        replay.data_rows =
        context->load_data == nullptr ? nullptr : &context->load_data->rows;
        replay.request_id   = script_request_id;
        replay.request_name = script_request_name;
        replay.sse_limits   = sse_limits;

        const auto totals = run_replay (engine, scopes, replay, failure_messages);
        sampled = totals.sampled;
        passed  = totals.passed;
        failed  = totals.failed;
    }

    store_validation_failures (db, context->run_id, failure_messages, passed, failed);

    if (verbose) {
        vayu::utils::log_info ("  Script validation: " + std::to_string (passed) +
        " passed, " + std::to_string (failed) + " failed");
    }

    validation.run = ScriptValidationTotals{ sampled, passed, failed };
    return validation;
}

SampledValidationTotals
validate_sampled_responses (const std::shared_ptr<RunContext>& context, bool verbose) {
    SampledValidationTotals totals;

    // Scenario load runs only. A single-request load run resolves no collection
    // and so no binding - the same reason it reports no coverage - and the
    // per-step stores are what a scenario run is recognised by, exactly as the
    // script pass recognises it.
    if (context->scenario == nullptr ||
    context->metrics_collector->step_sample_step_count () == 0) {
        return totals;
    }

    const auto& spec = context->scenario->spec;
    if (spec.response_schemas.empty ()) {
        return totals;
    }

    // The one parse of the document's schema index this run ever pays for, and
    // it happens after the last completion has landed. An index that will not
    // parse is "not measured", the reading every other reader of a stored index
    // gives it - never an empty contract that would pass every body.
    const auto index = ResponseSchemaIndex::parse (spec.response_schemas);
    if (!index) {
        return totals;
    }

    const auto& plan   = context->scenario->plan;
    const size_t steps = std::min (
    plan.steps.size (), context->metrics_collector->step_sample_step_count ());

    for (size_t i = 0; i < steps; ++i) {
        const auto& step = plan.steps[i];
        // A step bound to no operation is not a step this contract speaks
        // about. Skipped rather than counted as unchecked: it would fill the
        // block with `no_operation` for every unbound step of a mixed
        // collection, which says nothing about the contract.
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
                vayu::utils::log_warning (
                "Schema validation of a sample failed: " + std::string (e.what ()));
            }
        }
    }

    if (verbose && totals.sampled > 0) {
        vayu::utils::log_info ("  Schema validation: " + std::to_string (totals.checked) +
        " of " + std::to_string (totals.sampled) + " samples checked, " +
        std::to_string (totals.valid) + " valid, " +
        std::to_string (totals.failed) + " failed");
    }
    return totals;
}

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
        (*steps)[i]["tests"] = { { "sampled", tests->sampled },
            { "passed", tests->passed }, { "failed", tests->failed } };
    }
}

RunContext::RunContext (const std::string& id, nlohmann::json cfg, size_t max_errors, EngineDefaults engine_defaults)
: run_id (id),
  config (cfg.is_object () ? std::move (cfg) : nlohmann::json::object ()) {
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

    // Response capture for the retained samples. On by default because the
    // policy is failure-and-outlier-shaped rather than uniform - a healthy run
    // captures a handful of exemplars and nothing else. The per-body cap and
    // the whole-run budget default from engine config (both `data_retention`
    // keys) and can be overridden per run, the same way the retention caps are.
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
    // only, with no engine-wide setting beside `phaseHistograms`: that one
    // exists to switch off a cost *every* run pays, and this one is paid only
    // by a run that opted into streaming in the first place (issue #576).
    mc_config.stream_metrics = config.value (
    "stream_metrics", constants::metrics_collector::DEFAULT_STREAM_METRICS);

    // The caps a streaming run's transfers are bounded by. `stream` has already
    // been validated by `read_stream_flag` in the route, so a value here is a
    // boolean and each cap is an integer in range - this only has to choose
    // between the caller's number and the engine setting's.
    if (config.value ("stream", false)) {
        vayu::StreamBounds bounds;
        bounds.max_duration_ms =
        config.value ("maxStreamDurationMs", engine_defaults.stream_max_duration_ms);
        bounds.max_events =
        config.value ("maxStreamEvents", engine_defaults.stream_max_events);
        stream_bounds = bounds;
    }
    mc_config.max_exemplar_results =
    static_cast<size_t> (config.value ("max_exemplar_results",
    static_cast<int64_t> (constants::metrics_collector::DEFAULT_MAX_EXEMPLAR_RESULTS)));
    capture_response_bodies = mc_config.capture_response_bodies;

    // Configure response sampling for script validation
    mc_config.max_response_samples =
    static_cast<size_t> (config.value ("max_response_samples", 1000));
    mc_config.response_sample_rate =
    static_cast<size_t> (config.value ("response_sample_rate", 100));

    // Extract the test script from the run config (root level). Either a plain
    // string or a list of parts, under `tests` or the `postRequestScript(s)`
    // the same script is stored and sent to /execute under - one concept, and
    // `read_post_request_script` owns every name it answers to. Load runs
    // receive the collection chain's test scripts as well as the request's
    // own; before that, a collection-level assertion was silently never
    // checked.
    test_script = vayu::http::read_post_request_script (config);

    metrics_collector = std::make_unique<MetricsCollector> (id, mc_config);
}

RunContext::~RunContext () {
    should_stop = true;
    // Wake the closed-loop controller so it observes should_stop without
    // waiting for its 50ms safety-net timeout before the join below.
    notify_refill ();
    // The worker joins these itself before it returns; the join here only
    // covers a context destroyed before its worker ever ran. The *worker*
    // thread is owned by RunManager (run_workers_), never by the context - see
    // the declaration for why.
    join_aux_threads ();
}

void RunContext::join_aux_threads () {
    if (metrics_thread.joinable ()) {
        metrics_thread.join ();
    }
    // Same reasoning for the scrape loop: a joinable thread left on a
    // destroyed context is std::terminate, not a leak.
    if (monitor_thread.joinable ()) {
        monitor_thread.join ();
    }
    if (auth_refresh_thread.joinable ()) {
        auth_refresh_thread.join ();
    }
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
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = active_runs_.find (run_id);
    if (it == active_runs_.end ())
        return;
    it->second->completed_at_ms.store (now_ms ());
    retained_runs_[run_id] = it->second;
    active_runs_.erase (it);
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
            // Re-read the TTL each tick so a runtime change to liveRetentionMs
            // (Settings → Observability) takes effect without a daemon restart.
            // Sweep at half the TTL so a retained run is evicted within
            // ttl..1.5*ttl of completion; the 500ms cadence floor keeps a tiny
            // or zero TTL (retention disabled) from busy-looping. ttl==0 means
            // "evict immediately", which sweep_retained already handles.
            //
            // The provider reads the DB (the daemon wires it to get_config_int),
            // so it can throw; uncaught inside the sweeper thread that calls
            // std::terminate and takes the whole daemon down over a housekeeping
            // tick. A tick whose TTL could not be read is skipped rather than
            // swept against a guessed TTL, which would evict retained runs early.
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
        context->should_stop = true;
        context->notify_refill ();
    }

    if (!active.empty ()) {
        vayu::utils::log_info (
        "Stopping " + std::to_string (active.size ()) + " active load test(s)...");
        auto deadline = std::chrono::steady_clock::now () + grace;
        while (active_count () > 0 && std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        if (size_t remaining = active_count (); remaining > 0) {
            vayu::utils::log_warning (std::to_string (remaining) +
            " load test(s) had not settled after " + std::to_string (grace.count ()) +
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
        vayu::utils::log_info ("All load tests stopped");
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
const std::function<std::thread (const std::shared_ptr<RunContext>&)>& spawn) {
    // See the declaration for why `workers_mtx_` is held across the whole
    // block rather than just the insert.
    std::vector<std::thread> finished;
    {
        std::lock_guard<std::mutex> workers_lock (workers_mtx_);
        if (shutting_down_) {
            vayu::utils::log_warning (
            "Refusing to start run " + run_id + ": engine is shutting down");
            return false;
        }

        // Reap the handles of runs that have already finished, so a long-lived
        // daemon does not accumulate one per run. Done here rather than by the
        // workers themselves because a thread cannot join itself.
        finished = take_finished_workers ();

        // The config-backed defaults RunContext cannot read for itself - it
        // holds no Database - resolved here, the way `maxStoredErrors` always
        // has been. A run's own config still overrides each of them.
        EngineDefaults engine_defaults;
        engine_defaults.max_sample_body_bytes =
        static_cast<size_t> (db.get_config_int ("maxSampleBodyBytes",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES)));
        engine_defaults.phase_histograms =
        db.get_config_bool ("phaseHistograms",
        vayu::core::constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS);
        engine_defaults.max_sample_bytes =
        static_cast<size_t> (db.get_config_int ("maxSampleBytes",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES)));
        // The same two settings the design path's stream reads, so a user who
        // tightened them once has tightened them for both (issue #576).
        engine_defaults.stream_max_duration_ms =
        db.get_config_int ("sseMaxStreamDurationMs",
        static_cast<int> (vayu::core::constants::sse::MAX_STREAM_DURATION_MS));
        engine_defaults.stream_max_events =
        db.get_config_int ("sseMaxStreamEvents",
        static_cast<int> (vayu::core::constants::sse::MAX_STREAM_EVENTS));

        auto context = std::make_shared<RunContext> (run_id, config,
        static_cast<size_t> (db.get_config_int ("maxStoredErrors",
        static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS))),
        engine_defaults);
        register_run (run_id, context);

        // Sweep stale retained runs on each new registration so that headless /
        // API-only usage (which never hits /metrics/live) doesn't accumulate them.
        int retention_ms = db.get_config_int ("liveRetentionMs", 60000);
        sweep_retained (retention_ms);

        // IMPORTANT: Set is_running BEFORE spawning threads to avoid race condition
        // where metrics_thread exits immediately because is_running is still false
        context->is_running    = true;
        context->start_time_ms = now_ms ();

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
bool verbose,
std::shared_ptr<const ScenarioExecution> scenario,
std::unique_ptr<LoadDataSet> data) {
    return spawn_run (run_id, config, db, [&] (const std::shared_ptr<RunContext>& context) {
        // Set before either thread starts: the worker reads it to choose an
        // executor, and a later write would race the run it is meant to shape.
        context->scenario = std::move (scenario);
        // Same rule, same moment: the worker splits this set's request template
        // before its first submission and every strategy reads it after.
        context->load_data = std::move (data);
        // Spawn metrics collection thread first - it is NOT detached and is
        // joined by the worker thread below.
        context->metrics_thread =
        std::thread ([context, &db] () { collect_metrics (context, &db); });
        // Server vitals, when this run asked for them. Read from the config the
        // route already validated; `monitor_config_from` returning nothing here
        // means the run declared no monitor (or a snapshot this engine cannot
        // read), and the run proceeds exactly as it did before the block
        // existed. The totals live on the context so the summary can read them
        // once this thread has been joined.
        if (auto monitor =
            monitor_config_from (context->config, read_monitor_limits (db))) {
            context->monitor_totals = std::make_unique<MonitorTotals> ();
            context->monitor_thread =
            std::thread ([context, &db, cfg = std::move (*monitor)] () mutable {
                collect_monitor (context, &db, cfg);
            });
        }
        return std::thread ([context, &db, verbose, this] () {
            execute_load_test (context, &db, verbose, *this);
        });
    });
}

bool RunManager::start_scenario_run (const std::string& run_id,
const nlohmann::json& config,
std::shared_ptr<const ScenarioExecution> execution,
vayu::db::Database& db,
vayu::http::CookieJar& cookie_jar,
bool verbose) {
    return spawn_run (run_id, config, db,
    [&, execution = std::move (execution)] (const std::shared_ptr<RunContext>& context) {
        return std::thread ([context, execution, &db, &cookie_jar, verbose, this] () {
            execute_scenario_run (context, execution, &db, &cookie_jar, verbose, *this);
        });
    });
}

/**
 * The event loop this run drives, configured, started and published.
 *
 * Created, started, and only then published: the metrics thread has been ticking
 * since before this thread first ran (both are spawned by `start_run`, metrics
 * first) and reads the loop through `active_transfer_count()`, so the pointer
 * must land under the same lock (#956) - and only once the loop is already
 * started, so no reader can ever observe it half-built.
 */
void configure_event_loop (vayu::db::Database& db,
const nlohmann::json& config,
const std::shared_ptr<RunContext>& context,
size_t concurrency,
double target_rps,
int timeout_ms,
int configured_workers,
int default_max_per_host) {
    // Configure EventLoop
    vayu::http::EventLoopConfig loop_config;
    loop_config.num_workers = static_cast<size_t> (configured_workers); // Use configured workers (0 = auto-detect)
    loop_config.max_concurrent    = std::max (concurrency, size_t (100));
    loop_config.max_per_host      = static_cast<size_t> (default_max_per_host);
    loop_config.target_rps        = target_rps;
    loop_config.burst_size        = target_rps > 0 ? target_rps * 2.0 : 0.0;
    loop_config.dns_cache_timeout = db.get_config_int ("dnsCacheTimeout",
    vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS);
    // Read once for the run and held for it - see EventLoopConfig::transport
    // for why a per-request policy would cost the connection pool. The
    // client-certificate registry (#707) rides inside the policy and is
    // therefore read once here too, which is the whole of "load runs
    // resolve certificates at run start": libcurl reuses a pooled
    // connection only when its TLS identity matches, so a certificate that
    // could change mid-run would partition each worker's pool
    // (`event_loop_worker.cpp`, `FORBID_REUSE=0`) and pay a fresh handshake
    // per change. Matching per transfer stays cheap because it reads this
    // snapshot, never the database.
    loop_config.transport = vayu::http::resolve_transport_policy (db);
    loop_config.max_response_body_bytes = static_cast<size_t> (std::max (0,
    db.get_config_int ("maxResponseBodyBytes",
    static_cast<int> (vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES))));
    // Only enable curl verbose if explicitly requested in config,
    // independent of server verbose mode
    loop_config.verbose = config.value ("verbose", false);

    std::string workers_str =
    configured_workers == 0 ? "auto" : std::to_string (configured_workers);
    vayu::utils::log_debug ("EventLoop config: workers=" + workers_str +
    ", max_concurrent=" + std::to_string (loop_config.max_concurrent) +
    ", max_per_host=" + std::to_string (loop_config.max_per_host) +
    ", target_rps=" + std::to_string (target_rps) +
    ", timeout=" + std::to_string (timeout_ms) + "ms");

    // Create, start, and only then publish the event loop. The metrics
    // thread has been ticking since before this thread first ran (both are
    // spawned by start_run, metrics first) and reads the loop through
    // active_transfer_count(), so the pointer must land under the same
    // lock (#956) - and only once the loop is already started, so no
    // reader can ever observe it half-built.
    auto event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    event_loop->start ();
    context->publish_event_loop (std::move (event_loop));
}

/**
 * The one request a single-request load run sends, built once - deserialize,
 * timeout, auth - because the event loop attaches its headers to every transfer.
 *
 * A scenario load run has none: every step was composed and auth-resolved at
 * plan time, before the run row existed, and a step that could not be authorized
 * already failed resolution with a 400. Building one here would compose the
 * payload's absent method and url.
 *
 * @return false when the payload cannot be built - the caller fails the run.
 */
bool build_load_request (vayu::db::Database& db,
vayu::db::Database* db_ptr,
const nlohmann::json& config,
const std::shared_ptr<RunContext>& context,
int timeout_ms,
vayu::Request& request) {
    // Build the request once: deserialize + timeout + auth. The event loop
    // attaches request.headers to every transfer, so resolving auth here
    // covers the whole run.
    //
    // A scenario load run has no single request to build: every step was
    // composed and auth-resolved at plan time, before the run row existed,
    // and a step that could not be authorized already failed resolution
    // with a 400. Building one here would compose the payload's absent
    // method and url.
    if (context->scenario) {
        return true;
    }
    // Credentials carrying a `{{data.column}}` are the one case the build
    // leaves alone: the row has to reach them before `apply_auth` base64s them
    // out of reach (issue #591), so a run with rows tells the build to defer
    // and `bind_iteration` applies them per submission. Every other run
    // resolves its auth here exactly as it always did.
    const auto auth_resolution = context->load_data ?
    context->load_data->auth_resolution () :
    vayu::http::AuthResolution::Apply;
    auto built = vayu::http::build_request (config, db_ptr, timeout_ms, auth_resolution);
    if (!built.ok) {
        vayu::utils::log_error (built.parse_failed ?
        std::string ("Load test: invalid request format") :
        "Load test auth resolution failed: " + built.error_message);
        return false;
    }
    request = std::move (built.request);

    // Split once, here, so no submission re-scans the request's fields: a load
    // run binds at its full rate, which is the same reason a plan step is split
    // when the plan resolves (issue #993). The `{}` a row-free run keeps is
    // what makes the join free for it - it has no set at all.
    // Unconditionally, and not only for a run that has rows: the identity binds
    // off the iteration rather than off a row, so a run sent without `data` at
    // all still carries `{{$vu}}` / `{{$iteration}}` if its request spells them
    // (issue #994). A request carrying no reserved token leaves this empty, and
    // an empty template is what makes the per-submission join a single
    // `empty()` test.
    context->load_template = tokenize_bindable_fields (request);

    // A streaming run's caps ride on the request itself, because the
    // event loop is what enforces them and the request is all it sees.
    // Attached after `build_request` rather than inside it: the caps
    // are a property of *this* run's execution model, and the same
    // builder serves `POST /execute`, whose stream is managed by
    // `SseStreamManager` and must not acquire load bounds (issue #576).
    request.stream_bounds = context->stream_bounds;

    // A run that outlives its OAuth 2.0 token used to become a 401
    // storm the report never explained. Armed here, while the token
    // this run just resolved is still the one in the cache, and inert
    // for every auth that cannot be refreshed mid-run - see
    // plan_auth_refresh for that list.
    //
    // A scenario load run is deliberately not covered: each of its
    // steps resolved its own auth at plan time, before this run row
    // existed, so there is no single credential to keep current.
    if (auto plan = vayu::http::plan_auth_refresh (
        request, config.value ("auth", nlohmann::json ()), db_ptr)) {
        context->auth_refresh = std::make_shared<AuthRefreshState> (std::move (*plan));
        // The user's oauth2Refresh* settings, read once here: a run's
        // schedule must not change under it half way through.
        const AuthRefreshTuning tuning = read_auth_refresh_tuning (db);
        context->auth_refresh_thread = std::thread ([context, db_ptr, tuning] () {
            run_auth_refresh (context, db_ptr, tuning);
        });
    }
    return true;
}

/** The measured figures a finished run's summary is built from. */
struct RunTotals {
    size_t completed        = 0;
    double actual_rps       = 0.0;
    double total_duration_s = 0.0;
    double setup_overhead_s = 0.0;
    double latency_avg_ms   = 0.0;
    MetricsCollector::Percentiles latency;
};

/** Everything the stored whole-run summary is built from. */
RunSummaryInputs collect_summary_inputs (const std::shared_ptr<RunContext>& context,
const RunTotals& totals,
const ScriptValidation& validation,
const SampledValidationTotals& schema_totals,
const std::shared_ptr<ScenarioLoadState>& scenario_state) {
    RunSummaryInputs inputs;
    inputs.total_requests   = totals.completed;
    inputs.rps              = totals.actual_rps;
    inputs.send_rate        = totals.total_duration_s > 0 ?
           static_cast<double> (context->requests_sent.load ()) / totals.total_duration_s :
           0.0;
    inputs.throughput       = totals.actual_rps;
    inputs.test_duration_s  = totals.total_duration_s;
    inputs.setup_overhead_s = totals.setup_overhead_s;
    inputs.peak_concurrency = context->peak_in_flight.load ();
    inputs.dropped_requests = context->metrics_collector->dropped_requests ();
    inputs.queue_wait_avg_ms = context->metrics_collector->average_queue_wait ();
    inputs.bytes_sent     = context->metrics_collector->total_bytes_sent ();
    inputs.bytes_received = context->metrics_collector->total_bytes_received ();
    inputs.status_codes = context->metrics_collector->status_code_distribution ();
    inputs.latency        = totals.latency;
    inputs.latency_avg_ms = totals.latency_avg_ms;
    inputs.phases         = context->metrics_collector->phase_percentiles ();
    inputs.stream         = context->metrics_collector->stream_totals ();
    inputs.http_version_downgraded =
    context->metrics_collector->http_version_downgraded ();
    inputs.tests = validation.run;
    // Written by the capacity strategy before its execute() returned,
    // so it is already final here; absent for every other mode.
    inputs.capacity  = context->capacity;
    inputs.retention = read_retention (*context->metrics_collector);
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
        // Read on the same edge and for the same reason: a completion
        // still in flight is a request this contract was exercised with
        // (issue #629). Empty for a run of an unbound collection, which
        // the payload builder treats as absent.
        inputs.coverage = build_scenario_load_coverage (*scenario_state);
    }
    // Beside coverage, and deliberately not inside the `scenario_state`
    // block above: this pass reads the sample reservoirs, which are the
    // collector's, so it is available whether or not the executor left
    // a state behind. An empty object is treated as absent.
    inputs.schema_validation = build_sampled_validation_payload (schema_totals);

    // Judged last, off the filled inputs rather than off the collector:
    // the verdict has to be computed from the same numbers the summary
    // is about to store, or a report could print a p99 its own verdict
    // disagrees with. A run stopped early is judged on what it measured.
    inputs.thresholds = evaluate_thresholds (context->config, inputs);
    // What the refresh watchdog did, for a run that had one. Read after
    // the join above, so the tallies are final.
    if (context->auth_refresh) {
        inputs.auth = context->auth_refresh->summary ();
    }
    return inputs;
}

/**
 * Everything a finished run leaves behind: the flush, the two deferred passes,
 * the stored summary and the terminal status.
 *
 * Each step is guarded on its own, so one that fails costs only what it was
 * about to write - a run that measured something must still be reported as
 * finished.
 */
void finish_load_test (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
bool verbose,
double total_duration_s,
double setup_overhead_s,
double target_rps,
const std::shared_ptr<ScenarioLoadState>& scenario_state) {
    size_t completed   = context->total_requests ();
    size_t errors      = context->total_errors ();
    double avg_latency = context->average_latency_ms ();
    double actual_rps =
    total_duration_s > 0 ? static_cast<double> (completed) / total_duration_s : 0.0;
    double error_rate = context->metrics_collector->error_rate ();

    // Calculate percentiles using MetricsCollector (HdrHistogram)
    auto percentiles = context->metrics_collector->calculate_percentiles ();

    // Batch flush all results to database (errors and sampled successes)
    try {
        size_t flushed = context->metrics_collector->flush_to_database (db);
        if (verbose && flushed > 0) {
            vayu::utils::log_info (
            "  Flushed " + std::to_string (flushed) + " results to database");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Failed to flush results to database: " + std::string (e.what ()));
    }

    // Run deferred script validation if test script is present. Its tallies
    // go into the summary below, so it has to run before the summary write.
    ScriptValidation validation;
    try {
        validation = validate_scripts (context, db, verbose);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("Script validation failed: " + std::string (e.what ()));
    }

    // The other deferred pass over the same reservoirs (issue #682): what
    // the bound contract says about the responses that survived sampling.
    // Here, beside the script replay, for its reason - the completion path
    // refills concurrency, and neither pass may be on it.
    SampledValidationTotals schema_totals;
    try {
        schema_totals = validate_sampled_responses (context, verbose);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("Schema validation failed: " + std::string (e.what ()));
    }

    // Store the whole-run summary: everything the report used to rebuild by
    // scanning the run's metric rows, written once, here.
    try {
        const RunTotals totals{ completed, actual_rps, total_duration_s,
            setup_overhead_s, avg_latency, percentiles };
        const RunSummaryInputs inputs = collect_summary_inputs (
        context, totals, validation, schema_totals, scenario_state);
        db.update_run_summary (
        context->run_id, build_run_summary_payload (inputs).dump ());
    } catch (const std::exception& e) {
        vayu::utils::log_error ("Failed to store run summary: " + std::string (e.what ()));
    }

    // Update run status with retry logic to handle any remaining contention
    vayu::RunStatus final_status =
    context->should_stop ? vayu::RunStatus::Stopped : vayu::RunStatus::Completed;
    db.update_run_status_with_retry (context->run_id, final_status);

    // Terminal status reached - trim old runs per the retention knobs.
    // Best-effort: a prune failure must not fail the completed run.
    try {
        db.prune_runs_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("Run pruning failed: " + std::string (e.what ()));
    }

    if (verbose) {
        vayu::utils::log_info (
        "Load test " + context->run_id + " " + vayu::to_string (final_status));
        vayu::utils::log_info ("  Total requests: " + std::to_string (completed));
        vayu::utils::log_info ("  Errors: " + std::to_string (errors) + " (" +
        std::to_string (error_rate) + "%)");
        vayu::utils::log_info ("  Duration: " + std::to_string (total_duration_s) + " s");
        vayu::utils::log_info ("  Target RPS: " +
        (target_rps > 0 ? std::to_string (target_rps) : "unlimited"));
        vayu::utils::log_info ("  Actual RPS: " + std::to_string (actual_rps));
        vayu::utils::log_info ("  Avg latency: " + std::to_string (avg_latency) + " ms");
        vayu::utils::log_info ("  P50/P95/P99: " + std::to_string (percentiles.p50) +
        "/" + std::to_string (percentiles.p95) + "/" +
        std::to_string (percentiles.p99) + " ms");
    }
}

void execute_load_test (const std::shared_ptr<RunContext>& context,
vayu::db::Database* db_ptr,
bool verbose,
RunManager& manager) {
    // Note: is_running and start_time_ms are set in start_run() before threads
    // spawn to avoid race condition with metrics_thread

    auto& db           = *db_ptr;
    const auto& config = context->config;

    try {
        // Update status to running
        db.update_run_status (context->run_id, vayu::RunStatus::Running);

        // Get defaults from config (set via Settings UI)
        int default_max_concurrent = db.get_config_int (
        "eventLoopMaxConcurrent", vayu::core::constants::event_loop::MAX_CONCURRENT);
        int default_max_per_host = db.get_config_int (
        "eventLoopMaxPerHost", vayu::core::constants::event_loop::MAX_PER_HOST);
        int configured_workers = db.get_config_int ("workers", 0); // 0 = auto-detect

        // Per-test config can override defaults
        size_t concurrency =
        static_cast<size_t> (config.value ("concurrency", default_max_concurrent));
        double target_rps = config.value ("rps", 0.0); // 0 = unlimited
        if (target_rps == 0.0) {
            target_rps = config.value ("targetRps", 0.0);
        }
        int timeout_ms = config.value ("timeout", 30000);

        configure_event_loop (db, config, context, concurrency, target_rps,
        timeout_ms, configured_workers, default_max_per_host);

        vayu::Request request;
        if (!build_load_request (db, db_ptr, config, context, timeout_ms, request)) {
            db.update_run_status (context->run_id, vayu::RunStatus::Failed);
            context->is_running = false;
            context->join_aux_threads ();
            manager.retain_run (context->run_id);
            return;
        }

        // Execute Load Strategy
        auto test_start = std::chrono::steady_clock::now ();
        std::shared_ptr<ScenarioLoadState> scenario_state;

        try {
            if (context->scenario) {
                scenario_state = execute_scenario_load (context, db, *context->scenario);
            } else {
                auto strategy = LoadStrategy::create (config);
                strategy->execute (context, db, request);
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error ("Load test failed: " + std::string (e.what ()));
            db.update_run_status (context->run_id, vayu::RunStatus::Failed);
            context->is_running = false;
            context->join_aux_threads ();
            manager.retain_run (context->run_id);
            return;
        }

        // How the run lets go of the event loop depends on why it is ending.
        //
        // A user stop must stop *sending*: draining the queued backlog would
        // keep the target under load after the stop was requested, and waiting
        // on in-flight transfers hands the stop's latency to the upstream.
        // stop(false) discards the backlog and cancels what is in flight.
        //
        // The natural end of the duration still lets genuine in-flight requests
        // settle, but not forever: a request that has outlived its own timeout
        // by the grace period is never going to answer, and waiting on it pins
        // the run in `running` with no way out.
        //
        // Both reads are deliberately NOT under event_loop_mtx: this thread is
        // the one that published the pointer, so they are ordered by program
        // order, and stop() blocks for the whole drain - during which the
        // metrics thread must keep ticking through active_transfer_count(),
        // which takes that lock every tick.
        if (context->should_stop) {
            context->event_loop->stop (false);
        } else {
            const int64_t drain_ms =
            (timeout_ms > 0 ? timeout_ms : vayu::core::constants::server::DEFAULT_TIMEOUT_MS) +
            vayu::core::constants::event_loop::STOP_DRAIN_GRACE_MS;
            context->event_loop->stop (true, std::chrono::milliseconds (drain_ms));
        }

        // Record test end time immediately (before cleanup overhead)
        auto test_end = std::chrono::steady_clock::now ();
        double total_duration_s =
        std::chrono::duration<double> (test_end - test_start).count ();

        // Update end_time in DB immediately to reflect actual test end
        // (not after cleanup/metrics thread join)
        db.update_run_end_time (context->run_id);

        // Stop background collection and wait for the threads to finish
        context->is_running = false;

        // Properly join the auxiliary threads to ensure the tick thread is
        // done writing to the DB, the refresh watchdog has let go of it, and
        // the scrape loop's `monitor_totals` is final before the summary below
        // reads it.
        context->join_aux_threads ();

        // Calculate cleanup overhead (time from test end to after cleanup)
        auto cleanup_end = std::chrono::steady_clock::now ();
        const double setup_overhead_s =
        std::chrono::duration<double> (cleanup_end - test_end).count ();

        finish_load_test (context, db, verbose, total_duration_s,
        setup_overhead_s, target_rps, scenario_state);
    } catch (const std::exception& e) {
        // Stop background metrics collection and join it, like the two inner
        // failure paths do. Deferring the join to ~RunContext instead would run
        // it under RunManager::mutex_ during a later sweep eviction.
        context->is_running = false;
        context->join_aux_threads ();

        vayu::utils::log_error ("Load test error: " + std::string (e.what ()));

        // A crashed run still gets a summary, with whatever the collector holds
        // and a wall-clock duration - without one the report route would take
        // the legacy path and find nothing, reporting an empty run.
        //
        // Written *before* the status flips to Failed, matching the success
        // path: the terminal status is what tells a polling client the report
        // is ready, so a client that fetches on seeing it must not race a
        // summary still being written and get the empty-run answer instead.
        try {
            RunSummaryInputs inputs;
            auto& mc                       = *context->metrics_collector;
            inputs.total_requests          = mc.total_requests ();
            const double elapsed_s         = context->start_time_ms > 0 ?
                    static_cast<double> (now_ms () - context->start_time_ms) / 1000.0 :
                    0.0;
            inputs.rps                     = elapsed_s > 0 ?
                                static_cast<double> (inputs.total_requests) / elapsed_s :
                                0.0;
            inputs.send_rate               = elapsed_s > 0 ?
                          static_cast<double> (context->requests_sent.load ()) / elapsed_s :
                          0.0;
            inputs.throughput              = inputs.rps;
            inputs.test_duration_s         = elapsed_s;
            inputs.peak_concurrency        = context->peak_in_flight.load ();
            inputs.dropped_requests        = mc.dropped_requests ();
            inputs.queue_wait_avg_ms       = mc.average_queue_wait ();
            inputs.bytes_sent              = mc.total_bytes_sent ();
            inputs.bytes_received          = mc.total_bytes_received ();
            inputs.status_codes            = mc.status_code_distribution ();
            inputs.latency                 = mc.calculate_percentiles ();
            inputs.latency_avg_ms          = mc.average_latency ();
            inputs.phases                  = mc.phase_percentiles ();
            inputs.stream                  = mc.stream_totals ();
            inputs.retention               = read_retention (mc);
            inputs.http_version_downgraded = mc.http_version_downgraded ();
            if (context->auth_refresh) {
                inputs.auth = context->auth_refresh->summary ();
            }

            db.update_run_summary (
            context->run_id, build_run_summary_payload (inputs).dump ());
        } catch (const std::exception& ex) {
            vayu::utils::log_error (
            "Failed to store run summary for failed run: " + std::string (ex.what ()));
        }

        try {
            db.update_run_status_with_retry (context->run_id, vayu::RunStatus::Failed);
        } catch (const std::exception& ex) {
            vayu::utils::log_error (
            "Failed to update run status: " + std::string (ex.what ()));
        }

        // Failed is terminal too - prune per the retention knobs, best-effort.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& ex) {
            vayu::utils::log_warning ("Run pruning failed: " + std::string (ex.what ()));
        }
    }

    context->is_running = false;
    manager.retain_run (context->run_id);
}

std::string build_tick_payload (const nlohmann::json& stats, size_t offset) {
    return build_sse_frame ("metrics", stats.dump (), offset);
}

nlohmann::json build_metric_tick_payload (const MetricTickSample& sample) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : sample.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json payload;
    payload["timestamp"]           = sample.timestamp;
    payload["elapsed_seconds"]     = sample.elapsed_seconds;
    payload["requests_completed"]  = sample.requests_completed;
    payload["requests_failed"]     = sample.requests_failed;
    payload["current_rps"]         = sample.current_rps;
    payload["current_concurrency"] = sample.current_concurrency;
    payload["send_rate"]           = sample.send_rate;
    payload["throughput"]          = sample.throughput;
    payload["backpressure"]        = sample.backpressure;
    payload["error_rate"]          = sample.error_rate;
    payload["dropped_requests"]    = sample.dropped_requests;
    payload["bytes_sent"]          = sample.bytes_sent;
    payload["bytes_received"]      = sample.bytes_received;
    payload["status_codes"]        = codes;
    payload["latency_p50_ms"]      = sample.latency_p50_ms;
    payload["latency_p95_ms"]      = sample.latency_p95_ms;
    payload["latency_p99_ms"]      = sample.latency_p99_ms;
    return payload;
}

nlohmann::json build_run_summary_payload (const RunSummaryInputs& inputs) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : inputs.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json summary;
    summary["total_requests"]   = inputs.total_requests;
    summary["rps"]              = inputs.rps;
    summary["send_rate"]        = inputs.send_rate;
    summary["throughput"]       = inputs.throughput;
    summary["test_duration"]    = inputs.test_duration_s;
    summary["setup_overhead"]   = inputs.setup_overhead_s;
    summary["peak_concurrency"] = inputs.peak_concurrency;
    summary["dropped_requests"] = inputs.dropped_requests;
    summary["queue_wait_avg"]   = inputs.queue_wait_avg_ms;
    summary["bytes_sent"]       = inputs.bytes_sent;
    summary["bytes_received"]   = inputs.bytes_received;
    // Always written, including the 0 case. An absent key means "an engine too
    // old to have looked", which apply_stored_summary must be able to tell from
    // "looked, and every request got the protocol it asked for".
    summary["http_version_downgraded"] = inputs.http_version_downgraded;
    summary["status_codes"]            = codes;
    summary["latency"]                 = { { "min", inputs.latency.min },
                        { "max", inputs.latency.max }, { "avg", inputs.latency_avg_ms },
                        { "p50", inputs.latency.p50 }, { "p75", inputs.latency.p75 },
                        { "p90", inputs.latency.p90 }, { "p95", inputs.latency.p95 },
                        { "p99", inputs.latency.p99 }, { "p999", inputs.latency.p999 } };
    // What each bounded store thinned away. Always written: a reader that sees
    // the section and all zeros knows the stored set is complete, which a
    // missing section cannot say.
    summary["sampling"] = { { "errors_dropped", inputs.retention.errors_dropped },
        { "success_traces_dropped", inputs.retention.success_traces_dropped },
        { "slow_traces_dropped", inputs.retention.slow_traces_dropped },
        { "response_samples_dropped", inputs.retention.response_samples_dropped },
        { "exemplars_dropped", inputs.retention.exemplars_dropped },
        { "sample_bodies_dropped", inputs.retention.sample_bodies_dropped },
        // The run's own record that it captured response data verbatim. Read
        // by the Samples tab to warn about credentials, so it has to be
        // persisted rather than re-derived - the tab renders from the report
        // long after the collector is gone.
        { "response_bodies_captured", inputs.retention.response_bodies_captured } };
    // Omitted entirely when validation did not run, so the report keeps
    // distinguishing "no test script" from "a script that passed nothing".
    if (inputs.tests.has_value ()) {
        summary["tests"] = { { "sampled", inputs.tests->sampled },
            { "passed", inputs.tests->passed }, { "failed", inputs.tests->failed } };
    }
    // The run's verdict against the budgets it declared. Omitted when it
    // declared none, for the same reason `tests` is: "no budget" and "a budget
    // nothing was measured against" are different answers, and only the absent
    // section can say the first.
    if (inputs.thresholds.has_value ()) {
        nlohmann::json checks = nlohmann::json::array ();
        for (const auto& check : inputs.thresholds->checks) {
            checks.push_back ({ { "metric", check.metric }, { "limit", check.limit },
            { "actual", check.actual }, { "passed", check.passed } });
        }
        summary["thresholds"] = { { "checks", checks },
            { "passed", inputs.thresholds->passed },
            { "failed", inputs.thresholds->failed } };
    }
    // Per-phase latency distributions, keyed by wire name so a reader does not
    // have to know the enum's order. Omitted when the run recorded none - a
    // reader that finds no `phases` key is looking at a run whose phase data
    // was never collected, not at a target with a free TLS handshake.
    if (inputs.phases.has_value ()) {
        nlohmann::json phases      = nlohmann::json::object ();
        const auto& phase_measured = *inputs.phases;
        for (size_t i = 0; i < TIMING_PHASE_COUNT; ++i) {
            const auto& p = phase_measured.at (i);
            phases[TIMING_PHASE_KEYS.at (i)] = { { "p50", p.p50 }, { "p95", p.p95 },
                { "p99", p.p99 }, { "max", p.max }, { "count", p.count } };
        }
        summary["phases"] = phases;
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
    // Which of the bound contract's operations this run exercised (issue #629),
    // in the same shape the design-mode runner writes. Omitted for every run not
    // measured against a contract - an unbound collection, a single-request load
    // run, a document stored before the operation index existed - so an absent
    // section reads as "not measured" rather than as a contract nothing covered.
    if (inputs.coverage.has_value () && !inputs.coverage->empty ()) {
        summary["coverage"] = *inputs.coverage;
    }
    // What the deferred pass over this run's *sampled* responses found against
    // the bound contract (issue #682). Omitted, on the same empty-is-absent
    // terms as `coverage`, for every run that validated nothing - so an absent
    // section reads as "not checked" rather than as a contract nothing broke.
    // Unlike `coverage` beside it, these numbers describe the samples: the
    // block carries its own `sampled` denominator and the report says so.
    if (inputs.schema_validation.has_value () && !inputs.schema_validation->empty ()) {
        summary["schemaValidation"] = *inputs.schema_validation;
    }
    // What the server-vitals scrape recorded. Omitted for a run that configured
    // no monitor, so the report's section is absent rather than showing a run
    // that scraped nothing as one whose target reported zeros.
    if (inputs.monitor.has_value ()) {
        summary["monitor"] = *inputs.monitor;
    }
    // Whether this run's OAuth 2.0 credential was kept current, and at what
    // cost. Omitted for every run that could not refresh at all, so an absent
    // section reads as "this run was never watching" rather than as a run that
    // watched and saw nothing.
    if (inputs.auth.has_value ()) {
        summary["auth"] = *inputs.auth;
    }
    // What a streaming run's completions delivered (issue #576). Omitted for
    // every run that streamed nothing, so an absent section reads as "this run
    // was not a stream" rather than as a stream that carried no events.
    //
    // `eventsPerSecond` is derived here rather than stored, from the same
    // `test_duration` the report's `rps` uses - two rates a reader compares
    // must come off one clock. A zero-length run reports 0 rather than an
    // infinity the JSON could not hold.
    if (inputs.stream.has_value ()) {
        const auto& stream = *inputs.stream;
        summary["stream"]  = { { "completions", stream.completions },
             { "totalEvents", stream.total_events }, { "capped", stream.capped },
             { "eventsPerSecond",
            inputs.test_duration_s > 0.0 ?
             static_cast<double> (stream.total_events) / inputs.test_duration_s :
             0.0 },
             { "events",
             { { "min", stream.events.min }, { "max", stream.events.max },
             { "p50", stream.events.p50 }, { "p90", stream.events.p90 },
             { "p95", stream.events.p95 }, { "p99", stream.events.p99 },
             { "count", stream.events.count } } } };
    }
    return summary;
}

/** The rolling window a live tick published, reused by the persisted row. */
struct TickWindow {
    double p50 = 0.0;
    double p95 = 0.0;
    double p99 = 0.0;
};

/**
 * One persisted metric tick: the 1 Hz row every chart is drawn from.
 *
 * Built here as one wide row rather than reassembled from ~18 EAV rows by every
 * reader. A dropped tick is a hole in the run's history series and nothing
 * downstream can tell a hole from a quiet second, so the reason is logged rather
 * than swallowed - it never fails the run, whose live stream and final report
 * are built from the collector, not from these rows.
 */
void persist_metric_tick (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
int64_t tick_wall_ms,
double elapsed,
const std::map<int, size_t>& status_snapshot,
const TickWindow& window,
size_t& last_total,
int64_t& first_tick_wall_ms) {
    size_t current_total  = context->total_requests ();
    size_t current_errors = context->total_errors ();
    size_t delta          = current_total - last_total;

    double current_rps = elapsed > 0 ? static_cast<double> (delta) / elapsed : 0.0;
    double error_rate = current_total > 0 ?
    (static_cast<double> (current_errors) * 100.0 / static_cast<double> (current_total)) :
    0.0;

    // Calculate send rate (requests dispatched per second) and throughput (responses per second)
    size_t requests_sent = context->requests_sent.load ();
    double run_elapsed_s =
    (static_cast<double> (tick_wall_ms - context->start_time_ms)) / 1000.0;
    double send_rate =
    run_elapsed_s > 0 ? static_cast<double> (requests_sent) / run_elapsed_s : 0.0;
    double throughput =
    run_elapsed_s > 0 ? static_cast<double> (current_total) / run_elapsed_s : 0.0;

    // Calculate backpressure (true in-flight: requests sent but not yet responded)
    size_t backpressure = context->in_flight ();

    // One locked read shared by the debug line and the persisted
    // row below, so both report the same instant. Unlike the
    // direct dereference this replaces, a run whose loop is not
    // published yet - the runner still in its config reads one
    // second in - reports zero instead of dereferencing null.
    const size_t active_now = context->active_transfer_count ();

    // Sample the in-flight high-water mark. The closed-loop controller
    // also updates this at submit granularity; open-loop modes
    // (constant_rps) rely solely on this 1 Hz sample. CAS-max so the two
    // writers don't clobber each other.
    {
        size_t pk = context->peak_in_flight.load (std::memory_order_relaxed);
        while (backpressure > pk &&
        !context->peak_in_flight.compare_exchange_weak (
        pk, backpressure, std::memory_order_relaxed)) {
            // pk reloaded on failure
        }
    }

    vayu::utils::log_debug ("Metrics: rps=" + std::to_string (current_rps) +
    ", send_rate=" + std::to_string (send_rate) + ", throughput=" +
    std::to_string (throughput) + ", backpressure=" + std::to_string (backpressure) +
    ", error_rate=" + std::to_string (error_rate) + "%" + ", active=" +
    std::to_string (active_now) + ", sent=" + std::to_string (requests_sent));

    // Persist the tick: one wide row, built here rather than
    // reassembled from ~18 EAV rows by every reader.
    try {
        // elapsed_seconds is measured from the *first persisted*
        // tick, not from the run's start: the 1 Hz gate means the
        // first stored tick lands ~1s in, and a series that starts
        // at 0 is what the charts have always drawn.
        if (first_tick_wall_ms == 0) {
            first_tick_wall_ms = tick_wall_ms;
        }

        auto& mc = *context->metrics_collector;
        MetricTickSample sample;
        sample.timestamp = tick_wall_ms;
        sample.elapsed_seconds =
        static_cast<double> (tick_wall_ms - first_tick_wall_ms) / 1000.0;
        sample.requests_completed  = current_total;
        sample.requests_failed     = current_errors;
        sample.current_rps         = current_rps;
        sample.current_concurrency = active_now;
        sample.send_rate           = send_rate;
        sample.throughput          = throughput;
        sample.backpressure        = backpressure;
        sample.error_rate          = error_rate;
        sample.dropped_requests    = mc.dropped_requests ();
        sample.bytes_sent          = mc.total_bytes_sent ();
        sample.bytes_received      = mc.total_bytes_received ();
        // Reuse the snapshot already taken for the live tick above.
        sample.status_codes = status_snapshot;
        // Windowed (rolling) percentiles from the interval recorder -
        // these power the history percentile chart, the
        // response-time-vs-concurrency scatter, and the capacity
        // breakpoint / saturation derivations. Reuses the window
        // sampled by emit_live_tick this tick (do not re-sample).
        sample.latency_p50_ms = window.p50;
        sample.latency_p95_ms = window.p95;
        sample.latency_p99_ms = window.p99;

        db.add_metric_tick ({ 0, context->run_id, tick_wall_ms,
        build_metric_tick_payload (sample).dump () });
    } catch (const std::exception& e) {
        // A dropped tick is a hole in the run's history series and
        // nothing downstream can tell a hole from a quiet second,
        // so the reason is logged rather than swallowed. It never
        // fails the run: the live stream and the final report are
        // built from the collector, not from these rows. At most
        // one line per tick, and the tick gate is 1 Hz.
        vayu::utils::log_warning (
        "Metric tick not persisted for run " + context->run_id + ": " + e.what ());
    }

    last_total = current_total;
}

void collect_metrics (std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr) {
    auto& db          = *db_ptr;
    auto last_update  = std::chrono::steady_clock::now ();
    size_t last_total = 0;

    // Producer-side delta-RPS state (mirrors the SSE handler calculation).
    auto rps_last_time      = std::chrono::steady_clock::now ();
    size_t rps_last_total   = 0;
    double live_current_rps = 0.0;
    bool rps_first          = true;

    // Live tick cadence (default 100 ms); DB write still gated at 1 Hz.
    // Declared here so it is in scope inside the try block below.
    int tick_interval_ms = 0;

    // Wall clock of the first persisted tick; the origin every stored tick's
    // elapsed_seconds is relative to. 0 until the first DB-gated tick.
    int64_t first_tick_wall_ms = 0;

    // Windowed (rolling) percentiles sampled by emit_live_tick each tick. Captured
    // here so the 1 Hz DB-gated block below can persist the same window it just
    // published - sample_window_percentiles() resets the window, so it must only be
    // called once per tick (inside emit_live_tick) and reused, not re-sampled.
    double win_p50 = 0.0, win_p95 = 0.0, win_p99 = 0.0;

    // Build and append one SSE "metrics" event to the in-memory tick topic.
    // Fields match the SSE handler (metrics.cpp) field-for-field. The wall-clock
    // timestamp is passed in by the caller so that the SSE tick and any
    // persisted enrichment for the same logical tick share one timestamp -
    // re-sampling now_ms() inside drifts them into adjacent ms buckets and the
    // dashboard sees status-codes shift left vs throughput on the same x-axis.
    auto emit_live_tick = [&] (const std::map<int, size_t>* status_snapshot, int64_t now_wall_ms) {
        size_t active_count      = context->active_transfer_count ();
        size_t requests_sent     = context->requests_sent.load ();
        size_t requests_expected = context->requests_expected.load ();
        double elapsed_seconds   = context->start_time_ms > 0 ?
          static_cast<double> (now_wall_ms - context->start_time_ms) / 1000.0 :
          0.0;

        // Sample the rolling window exactly once per tick (it resets on read) and
        // carry the values out for the 1 Hz persistence below.
        auto window = context->metrics_collector->sample_window_percentiles ();
        win_p50     = window.p50;
        win_p95     = window.p95;
        win_p99     = window.p99;

        auto stats = context->metrics_collector->get_current_stats (active_count,
        elapsed_seconds, requests_sent, requests_expected, status_snapshot, &window);

        // Instantaneous RPS: delta-based, updated every ≥100 ms.
        auto now_steady      = std::chrono::steady_clock::now ();
        size_t current_total = stats["totalRequests"].get<size_t> ();
        if (rps_first) {
            rps_last_total = current_total;
            rps_last_time  = now_steady;
            rps_first      = false;
        } else {
            double iv =
            std::chrono::duration<double> (now_steady - rps_last_time).count ();
            if (iv >= 0.1) {
                live_current_rps =
                static_cast<double> (current_total - rps_last_total) / iv;
                rps_last_total = current_total;
                rps_last_time  = now_steady;
            }
        }
        stats["currentRps"] = live_current_rps;

        // Backpressure: sent but not yet responded (mirrors SSE handler).
        size_t backpressure =
        requests_sent > current_total ? requests_sent - current_total : 0;
        stats["backpressure"]     = backpressure;
        stats["runId"]            = context->run_id;
        stats["timestamp"]        = now_wall_ms;
        stats["requestsSent"]     = requests_sent;
        stats["requestsExpected"] = requests_expected;

        // Publish the same numbers to the strategies' feedback path, before
        // the SSE payload rather than after: a capacity search polls this every
        // tick, and the serialize-and-append below is the slower half.
        context->publish_live_tick ({ 0, win_p50, win_p95, win_p99,
        live_current_rps, backpressure, window.count });

        // Framed by the ring, which assigns the id under its own lock: a run
        // with a monitor has a second producer appending to it, and reading the
        // offset here would race that thread for the same id.
        context->append_event ("metrics", stats.dump ());
    };

    // Guard the entire body so that any exception (std::bad_alloc, json error,
    // etc.) is caught here rather than escaping the thread function (which would
    // call std::terminate).  `context->closed` is set unconditionally below the
    // try/catch so that attached /metrics/live consumers always terminate cleanly.
    try {
        tick_interval_ms = db_ptr->get_config_int (
        "liveTickIntervalMs", vayu::core::constants::server::STATS_INTERVAL_MS);

        // Size the replay ring from the configured window and this run's tick
        // cadence, so what is retained is the *duration* the user asked for
        // rather than a tick count that means a different span per cadence.
        // Read once here: changing the window mid-run would make the ids the
        // dashboard already holds refer to a differently-sized window.
        context->set_max_live_ticks (
        live_ring_size (db_ptr->get_config_int ("liveReplayWindowMs",
                        vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS),
        tick_interval_ms,
        static_cast<size_t> (db_ptr->get_config_int ("liveMaxRetainedTicks",
        static_cast<int> (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS)))));

        // Tick 0: emit immediately so consumers see data before the first sleep.
        emit_live_tick (nullptr, now_ms ());

        // Loop on is_running alone. should_stop is only the *request* to stop:
        // the worker acts on it, then blocks in event_loop->stop (cancelling on
        // a user stop, draining to a deadline at the natural end), and clears
        // is_running afterwards. Exiting on should_stop emitted the "final
        // settled tick" and set closed while hundreds of requests were still
        // settling, so the live view froze at the moment of the stop click
        // while the stored report - written after the worker returned -
        // counted everything that landed in between.
        while (context->is_running) {
            std::this_thread::sleep_for (std::chrono::milliseconds (tick_interval_ms));

            // Single wall-clock sample per tick - shared by the SSE payload
            // timestamp, the run-elapsed calc, and (on DB-gated ticks) every
            // persisted metric row below. See #27.
            int64_t tick_wall_ms = now_ms ();

            // Snapshot the status-code distribution once per tick and share it
            // with both the SSE builder and (on DB-gated ticks) the persisted
            // enrichment builder - avoids scanning/copying the map twice.
            auto status_snapshot = context->metrics_collector->status_code_distribution ();

            // Emit a live tick every iteration regardless of the 1 Hz DB gate.
            emit_live_tick (&status_snapshot, tick_wall_ms);

            auto now = std::chrono::steady_clock::now ();
            auto elapsed = std::chrono::duration<double> (now - last_update).count ();

            if (elapsed >= 1.0) // Update every second
            {
                persist_metric_tick (context, db, tick_wall_ms, elapsed, status_snapshot,
                TickWindow{ win_p50, win_p95, win_p99 }, last_total, first_tick_wall_ms);
                last_update = now;
            }
        }

        // Final settled tick before signalling closed - consumers use this ordering
        // as the termination contract (last data before closed==true).
        emit_live_tick (nullptr, now_ms ());
    } catch (const std::exception& e) {
        vayu::utils::log_error ("collect_metrics: " + std::string (e.what ()));
    } catch (...) {
        vayu::utils::log_error ("collect_metrics: unknown exception");
    }

    // Unconditional: always signal consumers so they terminate cleanly,
    // even if the producer threw.
    context->closed.store (true, std::memory_order_release);
}

/**
 * A scrape that read nothing: the transport failed, or the body carried none of
 * the requested names. Both mean this moment went unmeasured, and a stored
 * sample with no readings would draw a line through a hole in the data.
 *
 * The interval is doubled once, not per failure: the point is to stop hammering
 * an endpoint that is gone, not to drift so far out that a recovered one is
 * noticed minutes later.
 */
void note_monitor_gap (const std::shared_ptr<RunContext>& context,
const MonitorConfig& config,
int& consecutive_failures,
bool& backoff_logged,
int& interval_ms) {
    ++consecutive_failures;
    if (context->monitor_totals) {
        context->monitor_totals->record_failure ();
    }
    if (consecutive_failures == constants::monitor::FAILURES_BEFORE_BACKOFF) {
        if (!backoff_logged) {
            vayu::utils::log_warning ("Monitor scrape for run " + context->run_id +
            " has failed " + std::to_string (consecutive_failures) + " times in a row (" +
            config.url + "); backing off, the series will show gaps");
            backoff_logged = true;
        }
        // Doubled once, not per failure: the point is to stop
        // hammering an endpoint that is gone, not to drift so far
        // out that a recovered one is noticed minutes later.
        interval_ms = std::min (config.interval_ms * 2, constants::monitor::MAX_INTERVAL_MS);
    }
}

/** A scrape that read values: stored, published, and the backoff reset. */
void record_monitor_sample (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const MonitorConfig& config,
const std::map<std::string, double>& values,
int& consecutive_failures,
bool& backoff_logged,
int& interval_ms) {
    consecutive_failures = 0;
    backoff_logged       = false;
    interval_ms          = config.interval_ms;

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
        vayu::utils::log_warning ("Failed to store monitor sample for run " +
        context->run_id + ": " + e.what ());
    }
    context->append_event ("monitor", payload.dump ());
}

void collect_monitor (const std::shared_ptr<RunContext>& context,
vayu::db::Database* db_ptr,
const MonitorConfig& config) {
    auto& db = *db_ptr;

    // A scrape must not outlive its own cadence: the sample a late answer
    // carries is no longer about the moment it was asked for, and the loop
    // would spend the whole run behind itself. Derived from the interval unless
    // `monitorScrapeTimeoutMs` says otherwise - an exposition that takes longer
    // to render than the derivation allows would otherwise fail every scrape,
    // and the only way out was slowing the cadence, which also thins the data.
    const int timeout_ms =
    resolve_scrape_timeout_ms (config.interval_ms, config.scrape_timeout_ms);
    if (config.scrape_timeout_ms > timeout_ms) {
        // Said once, at the top: the setting is engine-wide but the cap is the
        // interval of *this* block, so a value that is fine for a slow run is
        // shortened on a fast one, and silence would look like the setting had
        // not taken.
        vayu::utils::log_warning ("Monitor scrape timeout for run " +
        context->run_id + " capped at the scrape interval (" +
        std::to_string (timeout_ms) + "ms); 'monitorScrapeTimeoutMs' is " +
        std::to_string (config.scrape_timeout_ms) + "ms, which is longer than this run's " +
        std::to_string (config.interval_ms) + "ms cadence");
    }

    // No cookie jar: this is the engine talking on its own behalf, like the
    // OAuth token call and the update check (see ClientConfig::cookie_jar).
    // The proxy is not the engine's own business though - a vitals endpoint
    // inside a corporate network is reached the same way everything else is
    // (issue #705). Resolved once, like the scrape cadence beside it, because
    // the loop below runs for the length of the run.
    vayu::http::ClientConfig monitor_client_config;
    monitor_client_config.transport = vayu::http::resolve_transport_policy (db);
    vayu::http::Client client{ monitor_client_config };

    int consecutive_failures = 0;
    bool backoff_logged      = false;
    int interval_ms          = config.interval_ms;

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

            std::map<std::string, double> values;
            auto sent = client.send (request);
            if (sent.is_ok () && !sent.value ().has_error () && sent.value ().is_success ()) {
                values =
                parse_monitor_body (config.format, sent.value ().body, config.series);
            }

            // A scrape that read nothing is a gap, whether the transport failed
            // or the body carried none of the requested names: both mean this
            // moment went unmeasured, and a stored sample with no readings
            // would draw a line through a hole in the data.
            if (values.empty ()) {
                note_monitor_gap (context, config, consecutive_failures,
                backoff_logged, interval_ms);
            } else {
                record_monitor_sample (context, db, config, values,
                consecutive_failures, backoff_logged, interval_ms);
            }

            // Sleep out the remainder of the interval in short slices. A run
            // that finishes joins this thread, so a single sleep_for would hold
            // the whole run open for up to a minute at the maximum interval.
            const auto deadline = scrape_started + std::chrono::milliseconds (interval_ms);
            while (context->is_running && std::chrono::steady_clock::now () < deadline) {
                std::this_thread::sleep_for (
                std::chrono::milliseconds (std::min (50, interval_ms)));
            }
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("collect_monitor: " + std::string (e.what ()));
    } catch (...) {
        vayu::utils::log_error ("collect_monitor: unknown exception");
    }
}

} // namespace vayu::core
