/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_runner.hpp"

#include <algorithm>
#include <chrono>
#include <deque>
#include <optional>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/status.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {

/// How many recently executed step names the cycle-bound message names. Enough
/// to show a loop of a few steps repeating, short enough to stay readable in a
/// `results.error` cell.
constexpr size_t CYCLE_TRAIL_LENGTH = 8;

int64_t runner_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// The first failed assertion, phrased for the `results.error` column: a
/// scenario step's failure has to say *which* expectation broke, because the
/// step list is all a reader has to go on.
std::string describe_failed_tests (const vayu::ScriptResult& pre,
const vayu::ScriptResult& post) {
    size_t failures = 0;
    std::string first;
    for (const auto* result : { &pre, &post }) {
        for (const auto& test : result->tests) {
            if (test.passed) {
                continue;
            }
            ++failures;
            if (first.empty ()) {
                first = test.name;
                if (!test.error_message.empty ()) {
                    first += ": " + test.error_message;
                }
            }
        }
    }
    if (failures == 0) {
        return "";
    }
    if (failures == 1) {
        return "Test failed - " + first;
    }
    return std::to_string (failures) + " tests failed - " + first;
}

/**
 * Whether a script *errored* rather than merely disagreeing with the response.
 *
 * `ScriptResult::success` is also the tests' verdict - `ScriptEngine::execute`
 * clears it when any `pm.test` fails - so it cannot be read as "the script
 * ran". The message is what separates the two: a thrown script, a timeout and a
 * refused `pm.request` write-back all carry one, and a failed expectation
 * carries none. Reading `success` alone would report every failed assertion as
 * a step that never ran, and end the iteration on it.
 */
bool script_errored (const vayu::ScriptResult& result) {
    return !result.success && !result.error_message.empty ();
}

/**
 * Decide what one exchange amounts to.
 *
 * The order is deliberate: a step that did not complete is `Errored` whatever
 * its scripts reported, and a script that threw is `Errored` rather than
 * `Failed`, because "the assertion did not hold" and "the assertion never ran"
 * are different facts and only the first one means the run learned something.
 */
StepOutcome classify_step (const vayu::http::routes::ExchangeOutcome& exchange,
std::string& error) {
    if (exchange.response.has_error ()) {
        error = exchange.response.error_message;
        return StepOutcome::Errored;
    }
    if (script_errored (exchange.pre_script_result)) {
        error = "Pre-request script failed - " + exchange.pre_script_result.error_message;
        return StepOutcome::Errored;
    }
    // After the script check and before everything that reads a response: a
    // script that asked to skip and then threw did both, and the throw is the
    // fact worth reporting. A skip itself is not a failure and carries no
    // error - but it is never a pass either (issue #180).
    if (!exchange.sent) {
        return StepOutcome::Skipped;
    }
    if (script_errored (exchange.post_script_result)) {
        error = "Test script failed - " + exchange.post_script_result.error_message;
        return StepOutcome::Errored;
    }
    if (auto failed = describe_failed_tests (
        exchange.pre_script_result, exchange.post_script_result);
    !failed.empty ()) {
        error = failed;
        return StepOutcome::Failed;
    }
    return StepOutcome::Passed;
}

/**
 * What this step's assertions came to, or `std::nullopt` for a step that made
 * none (issue #724).
 *
 * Both scripts, because that is what `build_script_result_node` serializes onto
 * the trace (issue #810) - the tally and the stored list count the same things,
 * so a step does not change its numbers when its row arrives. It also counts
 * what `describe_failed_tests` already fails the step on, which is what the two
 * disagreed about: a step could be `failed` by an assertion its own tally said
 * nothing about.
 */
std::optional<StepTestTally> tally_tests (const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result) {
    StepTestTally tally;
    for (const auto* result : { &pre_script_result, &post_script_result }) {
        for (const auto& test : result->tests) {
            if (test.passed) {
                ++tally.passed;
            } else {
                ++tally.failed;
            }
        }
    }
    if (tally.passed == 0 && tally.failed == 0) {
        return std::nullopt;
    }
    return tally;
}

/**
 * The verdict one step's response gets, or `std::nullopt` for a step nothing
 * judged (issue #681).
 *
 * The resolution the design-mode hook does per response - walk to the binding,
 * read the document, parse the index - happened once when the plan resolved and
 * once more when this run parsed @p index, so what is left here is the check
 * itself. That is what the binding carrying the schemas buys: a run of 200
 * steps would otherwise re-read and re-parse a document's whole schema index
 * 200 times, and would be free to get a different answer each time if a sync
 * landed mid-run.
 */
std::optional<vayu::core::ValidationVerdict> validate_step_response (const SpecBinding& spec,
const std::optional<ResponseSchemaIndex>& index,
const ScenarioStep& step,
const vayu::Response& response) {
    if (!spec.bound ()) {
        return std::nullopt;
    }
    if (!index) {
        ValidationVerdict verdict;
        verdict.reason = spec.schema_reason.value_or (UncheckedReason::NoIndex);
        return verdict;
    }

    const auto content_type = response.headers.find ("Content-Type");
    try {
        return index->check (step.spec_operation, response.status_code,
        content_type != response.headers.end () ? content_type->second : std::string (),
        response.body);
    } catch (const std::exception& e) {
        // A validator that threw is not a response that failed, and it is
        // certainly not a step that did - the design-mode hook's rule, for its
        // reason. The step keeps its outcome and loses only its verdict.
        vayu::utils::log_warning (
        "Step schema validation failed: " + std::string (e.what ()));
        return std::nullopt;
    }
}

/// The step's identity, added to the design-mode trace. `restore-response.ts`
/// reads the trace it already knows and ignores these; the app's step list
/// (phase 3) reads these to say which step a row belongs to.
void stamp_step_identity (nlohmann::json& trace, const StepRecord& record) {
    trace["iteration"] = record.iteration;
    trace["stepIndex"] = record.step_index;
    trace["stepName"]  = record.step_name;
    trace["requestId"] = record.request_id;
    trace["outcome"]   = to_string (record.outcome);
    // Only for a run that had rows: a run without a data set must not stamp a
    // `0` that reads as "row 1 of a data file" in the step list.
    if (record.data_row_index) {
        trace["dataRowIndex"] = *record.data_row_index;
    }
    // The *same object* the SSE frame carries, on the node design mode already
    // writes (`execution.cpp`'s `record_design_result`) - so the step list, the
    // restored response pane and the live frame cannot come to disagree about
    // what one response was judged to be. Absent when the step carries no
    // verdict, which is the state that means "nobody judged this".
    if (record.validation) {
        trace["validation"] = build_validation_payload (*record.validation);
    }
}

/// The steps an iteration most recently executed, joined for the cycle-bound
/// message. Bounded by the trail itself, not by the iteration: naming a hundred
/// executions would bury the two or three that actually loop.
std::string describe_recent_steps (const std::deque<std::string>& trail) {
    std::string described;
    for (const auto& name : trail) {
        if (!described.empty ()) {
            described += " -> ";
        }
        described += name;
    }
    return described;
}

} // namespace

ScenarioStepNameIndex build_step_name_index (const ScenarioPlan& plan) {
    ScenarioStepNameIndex index;
    for (size_t position = 0; position < plan.steps.size (); ++position) {
        index[plan.steps[position].name].push_back (position);
    }
    return index;
}

NextStepResolution resolve_next_step (const ScenarioStepNameIndex& index,
const std::string& target) {
    NextStepResolution resolution;

    auto found = index.find (target);
    if (found == index.end ()) {
        resolution.error =
        "setNextRequest(\"" + target + "\") names no request in this collection run";
        return resolution;
    }

    if (found->second.size () > 1) {
        std::string positions;
        for (size_t i = 0; i < found->second.size (); ++i) {
            if (i > 0) {
                positions += i + 1 == found->second.size () ? " and " : ", ";
            }
            positions += std::to_string (found->second[i]);
        }
        resolution.error = "setNextRequest(\"" + target +
        "\") is ambiguous - the name is carried by steps " + positions +
        "; rename one of them so the target names a single request";
        return resolution;
    }

    resolution.ok    = true;
    resolution.index = found->second.front ();
    return resolution;
}

size_t resolve_max_steps_per_iteration (int configured, size_t plan_steps) {
    if (configured > 0) {
        return static_cast<size_t> (configured);
    }
    return std::max (constants::scenario::MIN_STEPS_PER_ITERATION,
    plan_steps * constants::scenario::STEPS_PER_ITERATION_MULTIPLIER);
}

const char* to_string (StepOutcome outcome) {
    switch (outcome) {
    case StepOutcome::Passed: return "passed";
    case StepOutcome::Failed: return "failed";
    case StepOutcome::Skipped: return "skipped";
    case StepOutcome::Errored: return "errored";
    }
    return "unknown";
}

void ScenarioStepStore::add (vayu::db::Result result, bool kept_first) {
    const size_t sequence = sequence_++;

    if (capacity_ == 0 || stored () < capacity_) {
        (kept_first ? kept_first_ : fillers_).push_back ({ sequence, std::move (result) });
        return;
    }

    // Full. A step that did not pass takes a success's place - the newest one,
    // so what survives is the run's opening rather than an arbitrary slice.
    if (kept_first && !fillers_.empty ()) {
        fillers_.pop_back ();
        ++dropped_;
        kept_first_.push_back ({ sequence, std::move (result) });
        return;
    }

    ++dropped_;
}

std::vector<vayu::db::Result> ScenarioStepStore::take () {
    std::vector<Entry> merged;
    merged.reserve (kept_first_.size () + fillers_.size ());
    merged.insert (merged.end (), std::make_move_iterator (kept_first_.begin ()),
    std::make_move_iterator (kept_first_.end ()));
    merged.insert (merged.end (), std::make_move_iterator (fillers_.begin ()),
    std::make_move_iterator (fillers_.end ()));
    kept_first_.clear ();
    fillers_.clear ();

    std::sort (merged.begin (), merged.end (),
    [] (const Entry& a, const Entry& b) { return a.sequence < b.sequence; });

    std::vector<vayu::db::Result> results;
    results.reserve (merged.size ());
    for (auto& entry : merged) {
        results.push_back (std::move (entry.result));
    }
    return results;
}

std::string build_step_payload (const StepRecord& record, size_t offset) {
    nlohmann::json data{ { "iteration", record.iteration },
        { "stepIndex", record.step_index }, { "name", record.step_name },
        { "outcome", to_string (record.outcome) },
        { "statusCode", record.status_code }, { "latencyMs", record.latency_ms } };
    // Present on the same terms as on the stored row, so a step reads the same
    // live and after a reload rather than gaining a row number when the run
    // ends.
    if (record.data_row_index) {
        data["dataRowIndex"] = *record.data_row_index;
    }
    // On the frame as well as on the stored row, so a run being watched shows
    // its verdicts as they happen rather than only once the report is written.
    // Same terms as `dataRowIndex`: absent here is absent there.
    if (record.validation) {
        data["validation"] = build_validation_payload (*record.validation);
    }
    // The stored request this step ran (issue #831), so a step of a run being
    // *watched* has the same way back to its request that a stored one does -
    // the moment that link is worth most is the failure the reader is watching
    // arrive, not the report written after it. One id is constant-size, which
    // is what keeps it inside the ring rule the tally below states. Absent
    // when the plan step names no stored request, on the same terms as
    // everything else here: an empty id is not a link.
    if (!record.request_id.empty ()) {
        data["requestId"] = record.request_id;
    }
    // The assertions, as two numbers (issue #724). The list itself is on the
    // stored row: a frame carries what is constant-size, so a step that made
    // 400 assertions cannot push the rest of the run out of the tick ring.
    // Absent on the same terms as everything else here - a step that asserted
    // nothing sends no node rather than a `0/0` that reads as a result.
    if (record.tests) {
        data["tests"] = { { "passed", record.tests->passed },
            { "failed", record.tests->failed } };
    }
    return build_sse_frame ("step", data.dump (), offset);
}

bool read_fail_on_schema_error (const nlohmann::json& config) {
    auto field = config.find ("failOnSchemaError");
    return field != config.end () && field->is_boolean () && field->get<bool> ();
}

std::string describe_schema_failure (const ValidationVerdict& verdict) {
    const size_t total = verdict.failures_total > 0 ? verdict.failures_total :
                                                      verdict.failures.size ();
    std::string described = total == 1 ?
    "Response does not match the schema the spec declares" :
    std::to_string (total) + " schema problems in the response";
    if (!verdict.failures.empty ()) {
        const auto& first = verdict.failures.front ();
        described += " - " +
        (first.path.empty () ? std::string ("(body)") : first.path) + ": " +
        first.message;
    }
    return described;
}

nlohmann::json build_scenario_summary_payload (const ScenarioSummaryInputs& inputs) {
    nlohmann::json summary;
    // The three keys `apply_run_summary` reads. Without `total_requests` the
    // report would count the rows that survived the store's cap and call that
    // the run's size.
    summary["total_requests"] = inputs.steps_executed;
    summary["test_duration"]  = inputs.duration_s;
    summary["rps"]            = inputs.duration_s > 0 ?
               static_cast<double> (inputs.steps_executed) / inputs.duration_s :
               0.0;

    summary["scenario"] = { { "iterations", inputs.iterations_requested },
        { "iterations_completed", inputs.iterations_completed },
        { "steps_executed", inputs.steps_executed }, { "passed", inputs.passed },
        { "failed", inputs.failed }, { "skipped", inputs.skipped },
        { "errored", inputs.errored }, { "steps_stored", inputs.steps_stored },
        { "steps_dropped", inputs.steps_dropped } };
    // Its own top-level section rather than a member of `scenario`: coverage is
    // about the contract, not about the sequence, and the report route surfaces
    // it beside `thresholdValidation` for the same reason. Absent - never an
    // empty object - for a run that was not measured against one.
    if (!inputs.coverage.empty ()) {
        summary["coverage"] = inputs.coverage;
    }
    // Beside coverage rather than inside it, and on the same absent-when-not-
    // measured terms: the two answer different questions about one contract -
    // coverage says which of it the run touched, this says whether what came
    // back matched what it declares. A run of an unbound collection produces
    // neither, and a zero here would read as a contract it met.
    //
    // The load pass's payload builder, so the two run modes store one shape
    // (issue #681 on #682's block), with the two things only this mode knows
    // added on top.
    if (auto validation = build_sampled_validation_payload (inputs.validation);
    !validation.empty ()) {
        // **The denominator is every step, not a reservoir.** #682's block is
        // sampled by construction and its readers say so; this one is not, and
        // a reader told "no sampled response failed" about a run that checked
        // all of them has been told something narrower than the truth.
        validation["exact"] = true;
        // Stored with the tally it qualifies: a report read months later cannot
        // recover the flag from the run's config if the config was pruned, and
        // "3 failed" means a different run depending on it.
        validation["failOnSchemaError"] = inputs.fail_on_schema_error;
        summary["schemaValidation"]     = std::move (validation);
    }
    return summary;
}

/** What one step of an iteration needs from the run around it. */
struct StepContext {
    const std::shared_ptr<RunContext>& context;
    const std::shared_ptr<const ScenarioExecution>& execution;
    const std::optional<ResponseSchemaIndex>& schema_index;
    const vayu::http::TransportPolicy& transport;
    const std::string& cookie_scope;
    const std::vector<nlohmann::json>& data_rows;
    std::optional<size_t> data_row_index;
    size_t iteration            = 0;
    size_t iteration_count      = 0;
    bool fail_on_schema_error   = false;
    size_t max_trace_body_bytes = 0;
};

/**
 * The exchange one step performs: its inputs, the row bound into them, and the
 * send itself.
 *
 * Composition left every `{{data.column}}` written as it stands, because only
 * this loop knows which row is bound. A token naming a column the row does not
 * carry ends the step here rather than sending a request with a hole in it - the
 * partially bound request is still kept, because the trace is where the user
 * sees the token that had no column.
 *
 * @return the binding failure, empty when the step was sent.
 */
std::string run_step_exchange (vayu::runtime::ScriptEngine& script_engine,
vayu::http::CookieJar* cookie_jar,
const std::string& cookie_scope,
bool verbose,
vayu::http::routes::ScriptVariableScopes& scopes,
const StepContext& ctx,
const ScenarioStep& step,
vayu::http::routes::ExchangeOutcome& exchange) {
    vayu::http::routes::ExchangeInputs inputs;
    // A copy, not a move: the pre-request script writes back into
    // this request, and the next iteration must start from the
    // composed one rather than from whatever the last pass left.
    inputs.request         = step.request;
    inputs.pre_script      = step.pre_script;
    inputs.post_script     = step.post_script;
    inputs.request_id      = step.request_id;
    inputs.request_name    = step.name;
    inputs.iteration       = ctx.iteration;
    inputs.iteration_count = ctx.iteration_count;
    inputs.transport       = ctx.transport;
    // The one caller that sets it: `pm.execution` throws
    // everywhere else, because nowhere else has a sequence to
    // redirect (issue #355).
    inputs.in_scenario = true;

    // The data pass, per iteration and before the send: composition
    // left every `{{data.column}}` written as it stands, because
    // only this loop knows which row is bound. A token naming a
    // column the row does not carry ends the step here rather than
    // sending a request with a hole in it.
    std::string data_bind_error;
    if (ctx.data_row_index) {
        inputs.iteration_data = &ctx.data_rows[*ctx.data_row_index];
        // Through the step's own template rather than re-splitting
        // the request here: one binder for both executors, so a
        // step cannot bind differently depending on which one ran
        // it.
        auto bound = apply_data_template (inputs.request, step.data_template,
        ctx.data_rows[*ctx.data_row_index], *ctx.data_row_index);
        if (bound.ok) {
            // Then the credentials, for a step whose auth the plan
            // deliberately left unresolved: they have to carry the
            // row's values *before* `apply_auth` base64-encodes
            // them onto the request (issue #591). A no-op for every
            // other step.
            bound = bind_step_auth (inputs.request, step,
            ctx.data_rows[*ctx.data_row_index], *ctx.data_row_index);
        }
        if (!bound.ok) {
            data_bind_error = std::move (bound.error);
        }
    }

    if (data_bind_error.empty ()) {
        exchange = vayu::http::routes::execute_exchange (script_engine,
        *cookie_jar, cookie_scope, scopes, std::move (inputs), verbose);
    } else {
        // Nothing was sent and no script ran. The partially bound
        // request is kept anyway: the trace is where the user sees
        // the `{{data.*}}` token that had no column, which is the
        // thing they have to go and fix.
        exchange.request = std::move (inputs.request);
        exchange.sent    = false;
    }
    return data_bind_error;
}

/**
 * What the step did, as the row and the frame a reader sees.
 *
 * A row that could not bind is this step's failure and is not classifiable from
 * the exchange - there is no exchange. It errors rather than skipping: a skip is
 * a script's decision, this is a request that could not be built.
 */
StepRecord record_step (const StepContext& ctx,
const ScenarioStep& step,
const vayu::http::routes::ExchangeOutcome& exchange,
const std::string& data_bind_error,
ScenarioSummaryInputs& summary) {
    StepRecord record;
    record.iteration      = ctx.iteration;
    record.data_row_index = ctx.data_row_index;
    record.step_index     = step.index;
    record.step_name      = step.name;
    record.request_id     = step.request_id;
    // A row that could not bind is this step's failure and is not
    // classifiable from the exchange - there is no exchange. It
    // errors rather than skipping: a skip is a script's decision,
    // this is a request that could not be built.
    if (!data_bind_error.empty ()) {
        record.outcome = StepOutcome::Errored;
        record.error   = data_bind_error;
    } else {
        record.outcome = classify_step (exchange, record.error);
    }
    record.status_code = exchange.response.status_code;
    record.status_text = exchange.response.status_text;
    record.latency_ms  = exchange.response.timing.total_ms;
    // The assertions this step made (issue #724), for the frame a
    // live watcher reads. A step whose row could not bind ran no
    // script and gets no tally - `exchange` is the default one.
    record.tests = tally_tests (exchange.pre_script_result, exchange.post_script_result);

    // What the contract says about what came back (issue #681).
    // Only for a step that sent: a skipped step and one whose data
    // row would not bind produced no response, and a `checked:
    // false` verdict for them would be reporting on a request
    // nobody made - the same reading that erases `response` from
    // their trace below.
    if (exchange.sent) {
        record.validation = validate_step_response (
        ctx.execution->spec, ctx.schema_index, step, exchange.response);
        if (record.validation) {
            // The step's name and status ride the tally so a failure
            // example read far from the step list still says which
            // step produced it - the load pass's reason, unchanged.
            summary.validation.record (
            *record.validation, record.step_name, record.status_code);
        }
    }

    // The opt-in, applied before flow control reads the outcome. It
    // demotes **only a step that passed everything else**: a step
    // already failing an assertion or a transport error keeps the
    // error that named it, because that is the one a reader has to
    // fix first. With the flag off - the default - a schema failure
    // changes nothing here and lives entirely in its own channel.
    if (ctx.fail_on_schema_error && record.outcome == StepOutcome::Passed &&
    record.validation && record.validation->checked && !record.validation->valid) {
        record.outcome = StepOutcome::Failed;
        record.error   = describe_schema_failure (*record.validation);
    }
    return record;
}

/**
 * Where this iteration goes next, decided before the row is written: an
 * instruction that cannot be honoured is this step's error, and the record has
 * to say so.
 *
 * @return the position the iteration continues at; @p end_iteration says whether
 *         it continues at all.
 */
size_t decide_next_step (const vayu::http::routes::ExchangeOutcome& exchange,
const ScenarioStepNameIndex& name_index,
const std::deque<std::string>& recent_steps,
size_t position,
size_t steps_this_iteration,
size_t max_steps_per_iteration,
StepRecord& record,
bool& end_iteration) {
    // Where this iteration goes next, decided before the row is
    // written: an instruction that cannot be honoured is this
    // step's failure, so it has to reach `record.outcome` while the
    // row and the SSE event are still ahead of us.
    size_t next_position = position + 1;
    if (!end_iteration) {
        // The test script ran later, so its instruction wins over
        // the pre-request script's - "last call wins", across the
        // two scripts as within one. A skip comes only from the
        // pre-request script; the binding throws in a test script.
        const auto& control = exchange.post_script_result.control.kind !=
        vayu::ScriptControl::Kind::None ?
        exchange.post_script_result.control :
        exchange.pre_script_result.control;

        switch (control.kind) {
        case vayu::ScriptControl::Kind::None:
        case vayu::ScriptControl::Kind::Skip:
            // A skip has already happened - the exchange sent
            // nothing - and skipping one step is not a reason to
            // stop walking the plan.
            break;
        case vayu::ScriptControl::Kind::EndIteration:
            end_iteration = true;
            break;
        case vayu::ScriptControl::Kind::Next:
            if (steps_this_iteration >= max_steps_per_iteration) {
                record.outcome = StepOutcome::Errored;
                record.error   = "Iteration exceeded maxStepsPerIteration (" +
                std::to_string (max_steps_per_iteration) +
                ") - setNextRequest is cycling through: " + describe_recent_steps (recent_steps);
                end_iteration = true;
            } else if (auto next = resolve_next_step (name_index, control.target);
            !next.ok) {
                record.outcome = StepOutcome::Errored;
                record.error   = next.error;
                end_iteration  = true;
            } else {
                next_position = next.index;
            }
            break;
        }
    }
    return next_position;
}

/**
 * What the step leaves behind: its trace, the run's tallies, the stored row and
 * the live frame.
 */
void store_step_record (const StepContext& ctx,
const ScenarioStep& step,
const vayu::http::routes::ExchangeOutcome& exchange,
StepRecord& record,
CoverageTally& coverage,
ScenarioSummaryInputs& summary,
ScenarioStepStore& store) {
    record.trace =
    vayu::http::routes::build_result_trace (exchange.request, exchange.response);
    if (!exchange.sent) {
        // A skipped step has no response, and the empty one
        // `build_result_trace` writes for a default `Response`
        // would read in the step's expanded view as a server that
        // answered with nothing. The row keeps the request, which
        // is what the step actually amounted to.
        record.trace.erase ("response");
    }
    stamp_step_identity (record.trace, record);
    vayu::json::cap_trace_bodies (record.trace, ctx.max_trace_body_bytes);

    // What the scripts produced, on the node design mode already
    // writes and `restore-response.ts` already reads (issue #724).
    // Without it a step's detail could only ever show the one-line
    // summary `classify_step` folded the assertions into, while the
    // same request sent on its own shows every one of them.
    //
    // After the body cap for the reason `record_design_result`
    // gives: `cap_trace_bodies` walks the request and response body
    // nodes and does not reach this one, so writing it here makes
    // that impossible to misread as covered. Only when the scripts
    // said something - an empty node would put a Tests pane's worth
    // of nothing on every stored step.
    if (auto scripts = vayu::http::routes::build_script_result_node (
        exchange.pre_script_result, exchange.post_script_result);
    !scripts.empty ()) {
        record.trace["scripts"] = std::move (scripts);
    }

    ++summary.steps_executed;
    // Only a step that actually sent counts towards coverage: a
    // skipped step exercised no operation, and counting it would
    // report a contract as covered by a request nobody made.
    if (exchange.sent) {
        coverage.record (step.index, record.status_code);
    }
    switch (record.outcome) {
    case StepOutcome::Passed: ++summary.passed; break;
    case StepOutcome::Failed: ++summary.failed; break;
    case StepOutcome::Skipped: ++summary.skipped; break;
    case StepOutcome::Errored: ++summary.errored; break;
    }

    vayu::db::Result row;
    row.run_id      = ctx.context->run_id;
    row.timestamp   = runner_now_ms ();
    row.status_code = record.status_code;
    row.status_text = record.status_text;
    row.latency_ms  = record.latency_ms;
    row.error       = record.error;
    // A capped body may split a UTF-8 sequence and a response body
    // can be arbitrary bytes, so a lone continuation byte becomes
    // U+FFFD instead of throwing (store_result does the same).
    row.trace_data =
    record.trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    store.add (std::move (row), record.outcome != StepOutcome::Passed);

    ctx.context->append_tick (
    build_step_payload (record, ctx.context->published_count.load ()));
}

/**
 * One iteration: a walk over the plan rather than a pass through it.
 *
 * A script may send it backwards, forwards or out early, so the position is a
 * variable and the loop is bounded by the per-iteration budget rather than by
 * the plan's length.
 */
void run_iteration (vayu::runtime::ScriptEngine& script_engine,
vayu::http::CookieJar* cookie_jar,
const std::string& cookie_scope,
bool verbose,
vayu::http::routes::ScriptVariableScopes& scopes,
const StepContext& base,
const ScenarioPlan& plan,
const ScenarioStepNameIndex& name_index,
size_t max_steps_per_iteration,
CoverageTally& coverage,
ScenarioSummaryInputs& summary,
ScenarioStepStore& store) {
    size_t position             = 0;
    size_t steps_this_iteration = 0;
    std::deque<std::string> recent_steps;

    while (position < plan.steps.size ()) {
        // Checked per step, not per iteration: a 50-step iteration
        // would otherwise keep sending for minutes after the stop.
        if (base.context->should_stop) {
            break;
        }

        const auto& step = plan.steps[position];

        vayu::http::routes::ExchangeOutcome exchange;
        const StepContext& step_ctx       = base;
        const std::string data_bind_error = run_step_exchange (script_engine,
        cookie_jar, cookie_scope, verbose, scopes, step_ctx, step, exchange);

        ++steps_this_iteration;
        recent_steps.push_back (step.name);
        if (recent_steps.size () > CYCLE_TRAIL_LENGTH) {
            recent_steps.pop_front ();
        }

        StepRecord record =
        record_step (step_ctx, step, exchange, data_bind_error, summary);

        bool end_iteration = record.outcome == StepOutcome::Errored;
        const size_t next_position =
        decide_next_step (exchange, name_index, recent_steps, position,
        steps_this_iteration, max_steps_per_iteration, record, end_iteration);

        store_step_record (step_ctx, step, exchange, record, coverage, summary, store);

        if (record.outcome == StepOutcome::Errored) {
            // The iteration is over - a step that did not complete
            // leaves the ones after it standing on state that never
            // arrived. The run continues with the next iteration;
            // continue-on-failure is deliberately not invented ahead of
            // demand (design doc, "Deliberately left open").
            vayu::utils::log_warning ("Scenario run " + base.context->run_id +
            ": iteration " + std::to_string (base.iteration) +
            " ended at step '" + record.step_name + "' - " + record.error);
            break;
        }
        if (end_iteration) {
            break;
        }
        position = next_position;
    }
}

void execute_scenario_run (const std::shared_ptr<RunContext>& context,
const std::shared_ptr<const ScenarioExecution>& execution,
vayu::db::Database* db_ptr,
vayu::http::CookieJar* cookie_jar,
bool verbose,
RunManager& manager) {
    auto& db          = *db_ptr;
    const auto& plan  = execution->plan;
    const auto& asked = execution->request;

    ScenarioSummaryInputs summary;
    summary.iterations_requested = asked.iterations;
    const auto started_at        = std::chrono::steady_clock::now ();
    vayu::RunStatus final_status = vayu::RunStatus::Completed;

    // Built before the first send and read after the last, so a run that throws
    // mid-sequence still reports the operations it did exercise. Inactive for a
    // collection bound to nothing, in which case it records nothing and builds
    // nothing (issue #629).
    CoverageTally coverage = make_coverage_tally (*execution);

    // Whether the contract is a gate for this run, read once: it is a property
    // of who asked for the run, exactly as `allowScriptRequests` is, and a
    // value re-read per step could not change but could be got wrong twice.
    const bool fail_on_schema_error = read_fail_on_schema_error (context->config);
    summary.fail_on_schema_error = fail_on_schema_error;

    // Run-scoped, like every other read-once property above: a collection run
    // is one run, and steps that left the machine by different routes because
    // Settings changed mid-sequence would make its results unreproducible
    // (issue #705, epic decision 3 of #704).
    const auto transport = vayu::http::resolve_transport_policy (db);

    // The one parse of the document's schema index this run pays for, before
    // the first send rather than per step. `std::nullopt` - an unbound
    // collection, a document with no index, one that will not parse - is "not
    // measured", never an empty contract that would pass every body;
    // `validate_step_response` turns it into the reason the binding recorded.
    const auto schema_index = ResponseSchemaIndex::parse (execution->spec.response_schemas);

    try {
        db.update_run_status (context->run_id, vayu::RunStatus::Running);

        // Which jar every step reads and writes: one per environment, so "log
        // in on step 1, reuse the session on step 2" is the jar's existing
        // behaviour rather than anything this runner adds.
        std::optional<std::string> environment_id;
        if (auto it = context->config.find ("environmentId");
        it != context->config.end () && it->is_string () &&
        !it->get<std::string> ().empty ()) {
            environment_id = it->get<std::string> ();
        }
        const std::string cookie_scope =
        environment_id.value_or (std::string (vayu::http::NO_ENVIRONMENT_SCOPE));

        // Loaded once, mutated by every step, persisted once at the end. The
        // collection scope is the collection being run - a scenario has no
        // single request row to derive one from.
        auto scopes = vayu::http::routes::load_script_variable_scopes (
        db, environment_id, asked.collection_id);

        vayu::runtime::ScriptConfig script_config;
        script_config.timeout_ms = static_cast<uint64_t> (
        db.get_config_int ("scriptTimeout", constants::script_engine::TIMEOUT_MS));
        script_config.memory_limit = static_cast<size_t> (db.get_config_int (
        "scriptMemoryLimit", constants::script_engine::MEMORY_LIMIT));
        script_config.stack_size   = static_cast<size_t> (
        db.get_config_int ("scriptStackSize", constants::script_engine::STACK_SIZE));
        script_config.enable_console = db.get_config_bool (
        "scriptEnableConsole", constants::script_engine::ENABLE_CONSOLE);
        // Payload-level, exactly as `POST /execute` reads it: whether a script
        // may send is a property of who asked for this run.
        script_config.allow_send_request =
        vayu::http::read_allow_script_requests (context->config);

        // One engine for the whole run: QuickJS contexts are pooled and reset
        // per execution, so a per-step engine would pay for a runtime setup per
        // step and buy nothing.
        vayu::runtime::ScriptEngine script_engine (script_config);

        const auto max_trace_body_bytes = static_cast<size_t> (db.get_config_int (
        "maxTraceBodyBytes", static_cast<int> (constants::json::MAX_TRACE_BODY_BYTES)));
        ScenarioStepStore store (
        static_cast<size_t> (db.get_config_int ("maxScenarioStoredSteps",
        static_cast<int> (constants::scenario::MAX_STORED_STEPS))));

        // Flow control's two supports, both fixed for the run: where a
        // `setNextRequest` target resolves to, and how far one iteration may
        // travel before a cycle is called a cycle.
        const auto name_index                = build_step_name_index (plan);
        const size_t max_steps_per_iteration = resolve_max_steps_per_iteration (
        db.get_config_int ("maxStepsPerIteration", 0), plan.steps.size ());

        // The rows this run was given, bound one per iteration. Empty is the
        // ordinary case and keeps `pm.iterationData` undefined throughout.
        const auto& data_rows = execution->data_rows;

        for (size_t iteration = 0; iteration < asked.iterations; ++iteration) {
            if (context->should_stop) {
                break;
            }

            // Row `i % rows` binds to iteration `i`. An explicit `iterations`
            // above the row count wraps rather than running short, and every
            // record below carries the index so the wrap is visible.
            std::optional<size_t> data_row_index;
            if (!data_rows.empty ()) {
                data_row_index = iteration % data_rows.size ();
            }

            // An iteration is a walk over the plan rather than a pass through
            // it: a script may send it backwards, forwards or out early, so the
            // position is a variable and the loop is bounded by the budget
            // above rather than by the plan's length.
            const StepContext step_ctx{ context, execution, schema_index,
                transport, cookie_scope, data_rows, data_row_index, iteration,
                asked.iterations, fail_on_schema_error, max_trace_body_bytes };
            run_iteration (script_engine, cookie_jar, cookie_scope, verbose, scopes, step_ctx,
            plan, name_index, max_steps_per_iteration, coverage, summary, store);

            if (!context->should_stop) {
                ++summary.iterations_completed;
            }
        }

        // Once, at the end: per-step persistence would be N x M diff-and-write
        // cycles against the DB mutex for a value only this run's later steps
        // read. Best-effort, exactly as design mode's is.
        vayu::http::routes::persist_script_variables (db, environment_id,
        asked.collection_id, scopes.environment, scopes.globals, scopes.collection);

        summary.steps_dropped = store.dropped ();
        auto rows             = store.take ();
        summary.steps_stored  = rows.size ();
        try {
            db.add_results_batch (rows);
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Failed to store scenario step results: " + std::string (e.what ()));
            summary.steps_stored = 0;
        }

        final_status = context->should_stop ? vayu::RunStatus::Stopped :
                                              vayu::RunStatus::Completed;
    } catch (const std::exception& e) {
        vayu::utils::log_error ("Scenario run error: " + std::string (e.what ()));
        final_status = vayu::RunStatus::Failed;
    }

    // Everything below runs on every path, including the failed one: a run that
    // never reaches a terminal status is a run the app waits on forever.
    summary.duration_s =
    std::chrono::duration<double> (std::chrono::steady_clock::now () - started_at)
    .count ();
    summary.coverage = coverage.build ();

    try {
        db.update_run_end_time (context->run_id);
        db.update_run_summary (
        context->run_id, build_scenario_summary_payload (summary).dump ());
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Failed to store scenario run summary: " + std::string (e.what ()));
    }

    try {
        // Written after the summary, matching the load path: the terminal
        // status is what tells a polling client the report is ready.
        db.update_run_status_with_retry (context->run_id, final_status);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Failed to update scenario run status: " + std::string (e.what ()));
    }

    try {
        db.prune_runs_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("Run pruning failed: " + std::string (e.what ()));
    }

    if (verbose) {
        vayu::utils::log_info ("Scenario run " + context->run_id + " " +
        vayu::to_string (final_status) + ": " + std::to_string (summary.steps_executed) +
        " step(s) over " + std::to_string (summary.iterations_completed) + " iteration(s), " +
        std::to_string (summary.passed) + " passed, " + std::to_string (summary.failed) +
        " failed, " + std::to_string (summary.errored) + " errored");
    }

    context->is_running = false;
    // After the last step event, never before: a consumer treats `closed` as
    // "no more data is coming" and would otherwise stop one event short.
    context->closed.store (true, std::memory_order_release);
    manager.retain_run (context->run_id);
}

} // namespace vayu::core
