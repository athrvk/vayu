/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_runner.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <deque>
#include <iterator>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <unordered_map>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/script_config.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/core/transaction_histograms.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/status.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/log_text.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {

int64_t runner_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// Whether the exchange's error is the run's cancel landing (#3397): its
/// transfer answered `Cancelled`, or the late OAuth 2.0 token request ahead of
/// it was cancelled, which `acquire_token` reports as a network failure it
/// cannot tell from a cancel (`transport_failure` in `oauth_client.cpp`). Read
/// only while a Stop is latched, so a token endpoint that is down stays an
/// error.
bool ended_by_cancel (const vayu::http::routes::ExchangeOutcome& exchange) {
    return exchange.response.error_code == vayu::ErrorCode::Cancelled ||
    exchange.refusal_code == "oauth2_network_error";
}

/**
 * Decides what one exchange amounts to, onto @p record's outcome and error. The
 * order is deliberate: a step that did not complete is `Errored` whatever its
 * scripts reported, and a script that threw is `Errored`, not `Failed`, because
 * "the assertion did not hold" and "the assertion never ran" are different
 * facts and only the first means the run learned something. Each slot holds
 * every level's scripts folded together (#2522), so a throw or failed test at
 * the collection or a folder counts as the request's would. A step the run's
 * Stop cut short is `Stopped`, not `Errored` (#3397).
 */
void classify_step (const vayu::http::routes::ExchangeOutcome& exchange,
bool stop_requested,
StepRecord& record) {
    if (exchange.response.has_error ()) {
        record.outcome = stop_requested && ended_by_cancel (exchange) ?
        StepOutcome::Stopped :
        StepOutcome::Errored;
        record.error   = exchange.response.error_message;
        return;
    }
    if (script_threw (exchange.pre_script_result)) {
        record.outcome = StepOutcome::Errored;
        record.error   = vayu::http::routes::script_failure_text (
        exchange.pre_script_result, "pre-request");
        return;
    }
    // After the script check, before anything reading a response: a script that
    // asked to skip and then threw did both, and the throw is the fact worth
    // reporting. A skip is no failure and carries no error, but never a pass
    // either (#180).
    if (!exchange.sent) {
        record.outcome = StepOutcome::Skipped;
        return;
    }
    if (script_threw (exchange.post_script_result)) {
        record.outcome = StepOutcome::Errored;
        record.error =
        vayu::http::routes::script_failure_text (exchange.post_script_result, "test");
        return;
    }
    if (auto failed = describe_failed_tests (
        exchange.pre_script_result, exchange.post_script_result);
    !failed.empty ()) {
        record.outcome = StepOutcome::Failed;
        record.error   = failed;
        return;
    }
    record.outcome = StepOutcome::Passed;
}

/**
 * What this step's assertions came to, or `std::nullopt` for a step that made
 * none (#724). Both scripts, because `build_script_result_node` serializes both
 * onto the trace (#810), so the tally and the stored list count the same things
 * and a step keeps its numbers when its row arrives. It also counts what
 * `describe_failed_tests` fails the step on, so a step cannot be `failed` by an
 * assertion its own tally says nothing about.
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
 * This run's own latency percentiles, from the steps it sent: a nearest-rank
 * quantile over a sorted vector, not `MetricsCollector::calculate_percentiles`
 * (#1564). That collector is shared, already ticking for the run's live SSE
 * frames and tuned for a concurrent load run's histogram, so feeding it here to
 * read a snapshot at the end would make its idle live numbers reflect a
 * design-mode run mid-flight. A collection run's sample count is bounded by
 * iterations x steps, not a load run's duration, so one sort at the finish is
 * cheap.
 */
MetricsCollector::Percentiles percentiles_from_latencies (std::vector<double> latencies) {
    MetricsCollector::Percentiles result;
    result.count = latencies.size ();
    if (latencies.empty ()) {
        return result;
    }
    std::sort (latencies.begin (), latencies.end ());
    const auto at = [&latencies] (double pct) {
        const auto rank = static_cast<size_t> (
        std::ceil (pct / 100.0 * static_cast<double> (latencies.size ())));
        return latencies[std::min (rank == 0 ? size_t{ 0 } : rank - 1, latencies.size () - 1)];
    };
    result.min  = latencies.front ();
    result.max  = latencies.back ();
    result.p50  = at (50.0);
    result.p75  = at (75.0);
    result.p90  = at (90.0);
    result.p95  = at (95.0);
    result.p99  = at (99.0);
    result.p999 = at (99.9);
    return result;
}

/**
 * The verdict one step's response gets, or `std::nullopt` for a step nothing
 * judged (#681). The design-mode hook's per-response resolution (walk to the
 * binding, read the document, parse the index) happened once at plan time and
 * once when this run parsed @p index, so only the check is left. That is what
 * the binding carrying the schemas buys: a 200-step run would otherwise re-read
 * and re-parse a document's whole schema index 200 times, free to get a
 * different answer if a sync landed mid-run.
 */
std::optional<vayu::core::ValidationVerdict> validate_step_response (const SpecBinding& spec,
const std::optional<ResponseSchemaIndex>& index,
const ScenarioStep& step,
const vayu::Response& response,
const std::string& run_id) {
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
        // A validator that threw is not a failed response, still less a failed
        // step (the design-mode hook's rule, for its reason): the step keeps
        // its outcome and loses only its verdict.
        vayu::utils::log_warning ("run",
        "Step schema validation failed: " + std::string (e.what ()),
        { { "runId", run_id } });
        return std::nullopt;
    }
}

/// The step's identity, added to the design-mode trace. `restore-response.ts`
/// reads the trace it knows and ignores these; the app's step list reads them
/// to say which step a row belongs to.
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
    // Absent, not `0`, on every row but the one an error ended its iteration
    // at, so a row of a run where nothing was lost carries no such key.
    if (record.steps_not_run > 0) {
        trace["stepsNotRun"] = record.steps_not_run;
    }
    // The *same object* the SSE frame carries, on the node design mode writes
    // (`execution.cpp`'s `record_design_result`), so the step list, the
    // restored response pane and the live frame cannot disagree about one
    // response's verdict. Absent when the step has no verdict, meaning "nobody
    // judged this".
    if (record.validation) {
        trace["validation"] = build_validation_payload (*record.validation);
    }
}

/// How many different names @p names holds.
size_t count_distinct (std::vector<std::string> names) {
    std::sort (names.begin (), names.end ());
    return static_cast<size_t> (
    std::distance (names.begin (), std::unique (names.begin (), names.end ())));
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

ScenarioStepIndex build_step_index (const ScenarioPlan& plan) {
    ScenarioStepIndex index;
    for (size_t position = 0; position < plan.steps.size (); ++position) {
        index.by_name[plan.steps[position].name].push_back (position);
        // A step whose request has no id (plan tests build such steps, and this
        // type allows one) is indexed by name alone, not under an empty key
        // `setNextRequest("")` could never reach (the binding refuses an empty
        // target).
        if (!plan.steps[position].request_id.empty ()) {
            index.by_request_id[plan.steps[position].request_id].push_back (position);
        }
    }
    return index;
}

NextStepResolution
resolve_next_step (const ScenarioStepIndex& index, const std::string& target) {
    NextStepResolution resolution;

    // Postman's runner reads the string "null" as the stop form real `null`
    // means here, and the quoted spelling is endemic in collections written for
    // it. A step actually named `null` is the more specific answer and wins, so
    // this asks the name index rather than the string alone.
    if (target == "null" && !index.by_name.contains (target)) {
        resolution.kind = NextStepResolution::Kind::EndIteration;
        return resolution;
    }

    // Names first, ids second: a name is what a script author writes, and the
    // order is what keeps a collection whose request is *named* like some
    // other request's id resolving to the request the author can see.
    struct TargetKey {
        const ScenarioStepPositions* positions;
        std::string_view noun;
        /// What the author can actually do about a collision, which differs by
        /// key: two steps may be renamed, and two steps carrying one id is a
        /// plan that listed a request twice - nothing a rename fixes.
        std::string_view remedy;
    };
    const std::array<TargetKey, 2> keys{
        { { &index.by_name, "name", "rename one of them so the target names a single request" },
        { &index.by_request_id, "id", "jump by name instead - one request cannot be two steps of a run" } }
    };
    for (const auto& [positions, noun, remedy] : keys) {
        auto found = positions->find (target);
        if (found == positions->end ()) {
            continue;
        }

        if (found->second.size () > 1) {
            std::string steps;
            for (size_t i = 0; i < found->second.size (); ++i) {
                if (i > 0) {
                    steps += i + 1 == found->second.size () ? " and " : ", ";
                }
                steps += std::to_string (found->second[i]);
            }
            resolution.error = "setNextRequest(\"" + target + "\") is ambiguous - the ";
            resolution.error += noun;
            resolution.error += " is carried by steps ";
            resolution.error += steps;
            resolution.error += "; ";
            resolution.error += remedy;
            return resolution;
        }

        resolution.kind  = NextStepResolution::Kind::Step;
        resolution.index = found->second.front ();
        return resolution;
    }

    resolution.error = "setNextRequest(\"" + target +
    "\") matches no request name or id in this collection run";
    return resolution;
}

size_t resolve_max_steps_per_iteration (int configured, size_t plan_steps) {
    if (configured > 0) {
        return static_cast<size_t> (configured);
    }
    return std::max (constants::scenario::MIN_STEPS_PER_ITERATION,
    plan_steps * constants::scenario::STEPS_PER_ITERATION_MULTIPLIER);
}

std::string describe_steps_cap_exceeded (size_t max_steps_per_iteration,
const std::deque<std::string>& recent_steps) {
    // A jump reaches the runner as a bare target, from a script's
    // `setNextRequest`, a `control.switch` or a `control.loop`, so the message
    // names every source rather than guess.
    return "Iteration exceeded maxStepsPerIteration (" +
    std::to_string (max_steps_per_iteration) +
    ") - a jump keeps sending it back, either setNextRequest or control.switch "
    "cycling, or a control.loop whose count times its folder's members passes "
    "the limit (raise maxStepsPerIteration for that); most recent steps: " +
    describe_recent_steps (recent_steps);
}

const char* to_string (StepOutcome outcome) {
    switch (outcome) {
    case StepOutcome::Passed: return "passed";
    case StepOutcome::Failed: return "failed";
    case StepOutcome::Skipped: return "skipped";
    case StepOutcome::Errored: return "errored";
    case StepOutcome::Stopped: return "stopped";
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
    if (record.steps_not_run > 0) {
        data["stepsNotRun"] = record.steps_not_run;
    }
    // On the frame as well as on the stored row, so a run being watched shows
    // its verdicts as they happen rather than only once the report is written.
    // Same terms as `dataRowIndex`: absent here is absent there.
    if (record.validation) {
        data["validation"] = build_validation_payload (*record.validation);
    }
    // The stored request this step ran (#831), so a watched step has the way
    // back to its request a stored one does, most valuable for the failure the
    // reader is watching arrive. One constant-size id, inside the ring rule the
    // tally below states. Absent when the plan step names no stored request: an
    // empty id is not a link.
    if (!record.request_id.empty ()) {
        data["requestId"] = record.request_id;
    }
    // The assertions as two numbers (#724); the list is on the stored row. A
    // frame carries only constant-size data, so a step with 400 assertions
    // cannot push the rest of the run out of the tick ring. Absent for a step
    // that asserted nothing, rather than a `0/0` that reads as a result.
    if (record.tests) {
        data["tests"] = { { "passed", record.tests->passed },
            { "failed", record.tests->failed } };
    }
    // One number, as on the stored row (#3053), so a miss shows while the run
    // is watched; the outcomes behind it stay on the row.
    if (const size_t misses = vayu::core::count_extractor_misses (record.elements);
    misses > 0) {
        data["extractorMisses"] = misses;
    }
    // As on the stored row (#3248).
    if (record.unresolved_tokens > 0) {
        data["unresolvedTokens"] = record.unresolved_tokens;
    }
    // What the step sent (#3634), so a watcher can draw its row live. Absent
    // for a step that sent nothing, on the same terms as everything above.
    if (!record.method.empty ()) {
        data["method"] = record.method;
    }
    if (!record.url.empty ()) {
        data["url"] = record.url;
    }
    if (record.body_bytes) {
        data["bodyBytes"] = *record.body_bytes;
    }
    // The URL is a client string, so a byte that is not UTF-8 becomes U+FFFD
    // instead of throwing, as on the stored row.
    return build_sse_frame ("step",
    data.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace), offset);
}

nlohmann::json build_plan_payload (size_t steps_per_iteration, size_t iterations) {
    return nlohmann::json{ { "stepsPerIteration", steps_per_iteration },
        { "iterations", iterations },
        { "stepsExpected", steps_per_iteration * iterations } };
}

bool read_fail_on_schema_error (const nlohmann::json& config) {
    auto field = config.find ("failOnSchemaError");
    return field != config.end () && field->is_boolean () && field->get<bool> ();
}

bool read_stop_on_error (const nlohmann::json& config) {
    auto field = config.find ("stopOnError");
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

LatencySummary summarize_latencies (std::vector<double> latencies) {
    LatencySummary summary;
    if (latencies.empty ()) {
        return summary;
    }
    summary.avg_ms = std::accumulate (latencies.begin (), latencies.end (), 0.0) /
    static_cast<double> (latencies.size ());
    summary.percentiles = percentiles_from_latencies (std::move (latencies));
    return summary;
}

nlohmann::json build_scenario_summary_payload (const ScenarioSummaryInputs& inputs) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : inputs.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json summary;
    // A request is a step that sent (#2822): a skipped step is in
    // `scenario.steps_executed` and neither of these. The report takes
    // `status_codes` as the run's distribution and `total_requests` as its
    // size, so both count one population, and both are stored because the
    // result rows stop at `maxScenarioStoredSteps`. Written even when empty:
    // `{}` is a run in which no step sent, not an older summary that stored no
    // distribution.
    const auto requests_sent = vayu::count_status_failures (inputs.status_codes).total;
    summary["total_requests"] = requests_sent;
    summary["status_codes"]   = std::move (codes);
    summary["test_duration"]  = inputs.duration_s;
    summary["rps"]            = inputs.duration_s > 0 ?
    static_cast<double> (requests_sent) / inputs.duration_s :
    0.0;
    // Written at 0 too, as the load path does: the report reads a missing key
    // as 0 either way, but a stored 0 says the run counted and found none.
    summary["http_version_downgraded"] = inputs.http_version_downgraded;
    // Always written, `{}` included, the load path's rule (#3828).
    summary["error_classes"] = inputs.error_classes.to_json ();

    // The steps that sent, the sample a latency budget judges. A run in which
    // none did stores only `count: 0`: a block of zeros would read as instant
    // answers, and the report route leaves the section out on this marker.
    const auto& percentiles = inputs.latency.percentiles;
    summary["latency"]      = { { "count", percentiles.count } };
    if (percentiles.count > 0) {
        summary["latency"].update ({ { "min", percentiles.min },
        { "max", percentiles.max }, { "avg", inputs.latency.avg_ms },
        { "p50", percentiles.p50 }, { "p75", percentiles.p75 },
        { "p90", percentiles.p90 }, { "p95", percentiles.p95 },
        { "p99", percentiles.p99 }, { "p999", percentiles.p999 } });
    }

    summary["scenario"] = { { "iterations", inputs.iterations_requested },
        { "iterations_completed", inputs.iterations_completed },
        { "steps_executed", inputs.steps_executed }, { "passed", inputs.passed },
        { "failed", inputs.failed }, { "skipped", inputs.skipped },
        { "errored", inputs.errored }, { "stopped", inputs.stopped },
        { "steps_stored", inputs.steps_stored }, { "steps_dropped", inputs.steps_dropped },
        { "steps_not_run", inputs.steps_not_run },
        // Stored beside the counts it qualifies, as `failOnSchemaError` is
        // beside its tally: "1 errored, 0 not run" is a different run with it.
        { "stop_on_error", inputs.stop_on_error } };
    // `control.transaction`'s percentiles (#1515), absent for a run that
    // declared none, as `coverage` is.
    if (!inputs.transactions.empty ()) {
        summary["scenario"]["transactions"] = inputs.transactions;
    }
    // A top-level section, not a member of `scenario`: coverage is about the
    // contract, not the sequence, and the report route shows it beside
    // `thresholdValidation` for that reason. Absent, never an empty object, for
    // a run not measured against one.
    if (!inputs.coverage.empty ()) {
        summary["coverage"] = inputs.coverage;
    }
    // This run's custom metrics (#1500), under the top-level `customMetrics`
    // key the load path writes, in
    // `run_manager.cpp::build_run_summary_payload`'s shape, so
    // `GET /runs/:id/report` reads one section for both modes.
    if (inputs.custom_metrics.has_value ()) {
        summary["customMetrics"] = build_custom_metrics_payload (*inputs.custom_metrics);
    }
    if (!inputs.lifecycle.empty ()) {
        summary["lifecycle"] = inputs.lifecycle;
    }
    // Beside coverage, not inside it, on the same absent-when-not-measured
    // terms: coverage says which of the contract the run touched, this whether
    // what came back matched it. A run of an unbound collection produces
    // neither, and a zero here would read as a contract met.
    //
    // The load pass's payload builder, so both modes store one shape (#681 on
    // #682's block), plus the two things only this mode knows.
    if (auto validation = build_sampled_validation_payload (inputs.validation);
    !validation.empty ()) {
        // **The denominator is every step, not a reservoir.** #682's block is
        // sampled by construction and its readers say so; this one is not, and
        // "no sampled response failed" about a run that checked them all says
        // less than the truth.
        validation["exact"] = true;
        // Stored with the tally it qualifies: a report read months later cannot
        // recover the flag from a pruned config, and "3 failed" means a
        // different run depending on it.
        validation["failOnSchemaError"] = inputs.fail_on_schema_error;
        summary["schemaValidation"]     = std::move (validation);
    }
    // The verdict against the run's declared budgets (#1564), in the shape and
    // through the writer a load run's summary uses; `apply_stored_summary`
    // (`GET /runs/:id/report`) reads this key off either mode. Omitted when the
    // run declared no budgets, the absent-not-zeroed rule of every optional
    // section here.
    if (inputs.thresholds.has_value ()) {
        summary["thresholds"] = build_threshold_outcome_payload (*inputs.thresholds);
    }
    // The load path's section, through its writer, over the same
    // `test_duration` this summary's `rps` uses (#3235).
    if (inputs.stream.has_value ()) {
        summary["stream"] = build_stream_summary_payload (*inputs.stream, inputs.duration_s);
    }
    return summary;
}

/** What one step of an iteration needs from the run around it. */
struct StepContext {
    const std::shared_ptr<RunContext>& context;
    const std::shared_ptr<const ScenarioExecution>& execution;
    const std::optional<ResponseSchemaIndex>& schema_index;
    const vayu::http::TransportPolicy& transport;
    /// What the engine adds to every step's send (issue #1229). Run-scoped for
    /// the reason `transport` is: one collection run must not send two
    /// different header sets because Settings changed mid-sequence.
    const vayu::http::DefaultHeaderPolicy& default_headers;
    const std::string& cookie_scope;
    const std::vector<nlohmann::json>& data_rows;
    std::optional<size_t> data_row_index;
    size_t iteration            = 0;
    size_t iteration_count      = 0;
    bool fail_on_schema_error   = false;
    bool stop_on_error          = false;
    size_t max_trace_body_bytes = 0;
    /// `maxDesignResponseBodyBytes`, read once for the run (issue #1157).
    size_t max_response_bytes = 0;
    /// `maxElementBodyBytes`, read once for the run (#1514): a collection-run
    /// step is a design-mode send, so it reads the bound
    /// `ExchangeInputs::max_element_body_bytes` carries on that path.
    size_t max_element_body_bytes = 0;
    /// The plan-wide first/last position of every scope-spanning element
    /// (issue #1515's `control.loop` / `control.transaction`), computed
    /// once before the run's first iteration.
    const std::unordered_map<std::string, vayu::core::ElementSpan>& element_spans;
    /// Every controller kind's state (#1515's `control.once`,
    /// `control.throughput`, `control.transaction`), one map for the run's
    /// whole life, since a sequential run is #1512's single implicit user. A
    /// reference: every iteration's `StepContext` shares the one map a
    /// controller keeps counting into across iterations.
    std::unordered_map<std::string, int64_t>& controller_state;
    /// The token cache a step's OAuth 2.0 config acquires through after its
    /// pre-request script (`ExchangeInputs::token_cache`, #2521).
    vayu::db::Database* token_cache = nullptr;
    /// The `sse*` settings, read once for the run: what bounds a streaming
    /// step's stored `events` list (#3235) and the `pm.response.events` its
    /// post-request script reads (#3769).
    const vayu::http::SseLimits& sse_limits;
};

/**
 * The exchange one step performs: its inputs, the row bound into them, and the
 * send. Composition left every `{{data.column}}` written, because only this
 * loop knows which row is bound. A token naming a column the row lacks ends the
 * step here rather than sending a request with a hole in it; the partially
 * bound request is kept, because the trace is where the user sees the token
 * that had no column.
 *
 * @return the binding failure, empty when the step was sent.
 */
std::string run_step_exchange (vayu::runtime::ScriptEngine& script_engine,
vayu::http::CookieJar* cookie_jar,
const std::string& cookie_scope,
vayu::http::routes::ScriptVariableScopes& scopes,
const StepContext& ctx,
const ScenarioStep& step,
vayu::http::routes::ExchangeOutcome& exchange) {
    vayu::http::routes::ExchangeInputs inputs;
    // A copy, not a move: the pre-request script writes back into this request,
    // and the next iteration must start from the composed one.
    inputs.request          = step.request;
    inputs.elements         = step.elements;
    inputs.request_id       = step.request_id;
    inputs.request_name     = step.name;
    inputs.iteration        = ctx.iteration;
    inputs.step_position    = step.index;
    inputs.element_spans    = &ctx.element_spans;
    inputs.controller_state = &ctx.controller_state;
    // One user walking the sequence, which is what a collection run in design
    // mode is - the same number `{{$vu}}` binds into its requests (issue #994).
    inputs.vu              = SOLE_VIRTUAL_USER;
    inputs.iteration_count = ctx.iteration_count;
    inputs.transport       = ctx.transport;
    inputs.default_headers = ctx.default_headers;
    inputs.token_cache     = ctx.token_cache;
    // The run's caller's host rule (#2521), judged on each step's final URL.
    const auto& target_policy     = ctx.context->target_policy;
    inputs.target_policy          = target_policy ? &*target_policy : nullptr;
    inputs.max_response_bytes     = ctx.max_response_bytes;
    inputs.max_element_body_bytes = ctx.max_element_body_bytes;
    inputs.sse_limits             = ctx.sse_limits;
    // The files the plan already checked (`ScenarioExecution::files`); a step
    // re-checks nothing it saw at plan time.
    inputs.files = ctx.execution->files.get ();
    // The one caller that sets it: `pm.execution` throws everywhere else, since
    // nowhere else has a sequence to redirect (#355).
    inputs.in_scenario = true;
    // A `timer.pacing` element's `step.before` dispatch (#1498) reads these off
    // its run; a design send's `ExchangeInputs` leaves all four null, which
    // keeps pacing meaningless there.
    inputs.pacing_state    = &ctx.context->pacing_state;
    inputs.rng             = &ctx.context->rng;
    inputs.timers_override = &ctx.context->timers_override;
    inputs.should_stop     = [&] { return ctx.context->should_stop.load (); };
    // Stop and shutdown end the step's transfer, its late token request and
    // its scripts' `pm.sendRequest` (#3397), and a script still running
    // (#3460), never waiting out a timeout.
    inputs.cancel = &ctx.context->should_stop;
    inputs.stop   = &ctx.context->should_stop;
    // `metric.record` and `pm.metrics` (#1500) record into this run's
    // collector; a design send binds neither and reports "not available here".
    inputs.record_metric = [&ctx] (const std::string& name,
                           vayu::core::CustomMetricType type, double value) {
        ctx.context->metrics_collector->record_custom_metric (name, type, value);
    };

    // The data pass, per iteration, before the send (the docblock above says
    // why here).
    std::string data_bind_error;
    if (ctx.data_row_index) {
        inputs.iteration_data = &ctx.data_rows[*ctx.data_row_index];
    }
    // Through the step's own templates, not a re-split, and through the one
    // binder every executor drives, so a step binds the same whichever ran it:
    // fields first, then the credentials the plan left unresolved, the order
    // `apply_auth` makes load-bearing (#591), and the iteration's identity last
    // (#994). A collection run is one user walking the sequence, so `{{$vu}}`
    // is 1 and `{{$iteration}}` the run's iteration index. Auth waiting on the
    // step's scripts (#2473) lands in `late_auth`, which the exchange applies
    // after the pre-request script.
    if (auto bound = bind_step_iteration (inputs.request, step, ctx.data_rows,
        ctx.data_row_index,
        IterationIdentity{ SOLE_VIRTUAL_USER, ctx.iteration }, inputs.late_auth);
    !bound.ok) {
        data_bind_error = std::move (bound.error);
    }

    if (data_bind_error.empty ()) {
        exchange = vayu::http::routes::execute_exchange (
        script_engine, *cookie_jar, cookie_scope, scopes, std::move (inputs));
    } else {
        // Nothing was sent and no script ran. The partially bound request is
        // kept: the trace is where the user sees the `{{data.*}}` token that
        // had no column, the thing to fix.
        exchange.request = std::move (inputs.request);
        exchange.sent    = false;
    }
    return data_bind_error;
}

/// The URL a `step` frame carries: credentials masked as an export masks them
/// (the password of `user:pass@`, a credential query parameter's value, the one
/// the step's own auth wrote), but as `<redacted>` where an export leaves a
/// blank, then cut to `STEP_FRAME_URL_MAX_BYTES` on a character boundary.
/// Masked first, so a credential straddling the cut cannot survive as a prefix
/// of itself.
std::string step_frame_url (const vayu::Request& request) {
    std::vector<std::string> auth_params;
    if (!request.auth_query_param.empty ()) {
        auth_params.push_back (request.auth_query_param);
    }
    int omitted              = 0;
    const std::string masked = vayu::core::vayu_ext::redact_url_credentials (
    request.url, auth_params, omitted, vayu::core::vayu_ext::CredentialMark::Marker);
    return std::string (vayu::utils::without_incomplete_utf8_tail (
    std::string_view (masked).substr (0, STEP_FRAME_URL_MAX_BYTES)));
}

/// What the step did, as the row and the frame a reader sees. A row that could
/// not bind is the step's failure and not classifiable, as there is no
/// exchange; it errors rather than skips: a skip is a script's decision, this a
/// request that could not be built.
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
    // A bind failure errors (the docblock above).
    if (!data_bind_error.empty ()) {
        record.outcome = StepOutcome::Errored;
        record.error   = data_bind_error;
    } else {
        classify_step (exchange, ctx.context->stop_was_requested (), record);
    }
    record.status_code       = exchange.response.status_code;
    record.status_text       = exchange.response.status_text;
    record.latency_ms        = exchange.response.timing.total_ms;
    record.unresolved_tokens = count_distinct (exchange.unresolved_tokens);
    // A step that sent nothing has no request to name (#3634): a skip's
    // `exchange` and a row that could not bind hold a default one.
    if (exchange.sent && data_bind_error.empty ()) {
        record.method = to_string (exchange.request.method);
        record.url    = step_frame_url (exchange.request);
        record.body_bytes =
        exchange.response.stream_body_bytes.value_or (exchange.response.body_size);
    }
    // The step's assertions (#724), for the frame a live watcher reads. A step
    // whose row could not bind ran no script and gets no tally (`exchange` is
    // the default one); nor does a stopped step, since a test judging a
    // cancelled send is no verdict.
    if (record.outcome != StepOutcome::Stopped) {
        record.tests = tally_tests (exchange.pre_script_result, exchange.post_script_result);
    }
    // `step.before` and `step.after`'s outcomes (issue #1514); the caller
    // (`run_iteration`) appends `step.between`'s onto this same vector.
    record.elements = exchange.element_outcomes;
    if (data_bind_error.empty ()) {
        record.script_ms = exchange.script_ms;
    }

    // What the contract says about the response (#681), only for a step that
    // sent: a skipped step and one whose row would not bind produced none, and
    // a `checked: false` verdict would report on a request nobody made, the
    // reading that erases `response` from their trace below. A stopped step's
    // send was cut short and brought back nothing to judge either.
    if (exchange.sent && record.outcome != StepOutcome::Stopped) {
        record.validation = validate_step_response (ctx.execution->spec,
        ctx.schema_index, step, exchange.response, ctx.context->run_id);
        if (record.validation) {
            // The step's name and status ride the tally so a failure example
            // read far from the step list still names its step, the load pass's
            // reason.
            summary.validation.record (
            *record.validation, record.step_name, record.status_code);
        }
    }

    // The opt-in, applied before flow control reads the outcome. It demotes
    // **only a step that passed everything else**: one already failing an
    // assertion or a transport error keeps the error that named it, the one a
    // reader must fix first. With the flag off (the default) a schema failure
    // changes nothing here and lives in its own channel.
    if (ctx.fail_on_schema_error && record.outcome == StepOutcome::Passed &&
    record.validation && record.validation->checked && !record.validation->valid) {
        record.outcome = StepOutcome::Failed;
        record.error   = describe_schema_failure (*record.validation);
    }
    return record;
}

/**
 * Where this iteration goes after a step that did not error, decided before the
 * row is written: an instruction that cannot be honoured is this step's error,
 * and the record must say so while the row and the SSE event are still ahead.
 * An errored step's own instruction is never read here (#2526): it came from a
 * script that did not finish.
 *
 * @return the position the iteration continues at; @p end_iteration is set when
 *         it does not continue.
 */
size_t decide_next_step (const vayu::http::routes::ExchangeOutcome& exchange,
const ScenarioStepIndex& step_index,
const std::deque<std::string>& recent_steps,
size_t position,
size_t steps_this_iteration,
size_t max_steps_per_iteration,
StepRecord& record,
bool& end_iteration) {
    size_t next_position = position + 1;
    // The test script ran later, so its instruction wins over the pre-request
    // script's ("last call wins", across scripts as within one). A skip comes
    // only from the pre-request script; the binding throws in a test script.
    const auto& control =
    exchange.post_script_result.control.kind != vayu::ScriptControl::Kind::None ?
    exchange.post_script_result.control :
    exchange.pre_script_result.control;

    switch (control.kind) {
    case vayu::ScriptControl::Kind::None:
    case vayu::ScriptControl::Kind::Skip:
        // A skip has already happened - the exchange sent nothing - and
        // skipping one step is not a reason to stop walking the plan.
        break;
    case vayu::ScriptControl::Kind::EndIteration: end_iteration = true; break;
    case vayu::ScriptControl::Kind::Next:
        if (steps_this_iteration >= max_steps_per_iteration) {
            record.outcome = StepOutcome::Errored;
            record.error =
            describe_steps_cap_exceeded (max_steps_per_iteration, recent_steps);
            end_iteration = true;
            break;
        }
        // Three answers, not two: a target may *be* the stop form,
        // `setNextRequest("null")`, which Postman's runner reads as the real
        // `null` the other arm handles.
        switch (auto next = resolve_next_step (step_index, control.target); next.kind) {
        case NextStepResolution::Kind::Unresolved:
            record.outcome = StepOutcome::Errored;
            record.error   = next.error;
            end_iteration  = true;
            break;
        case NextStepResolution::Kind::EndIteration:
            end_iteration = true;
            break;
        case NextStepResolution::Kind::Step: next_position = next.index; break;
        }
        break;
    }
    return next_position;
}


/// The plan positions after @p position this iteration has not attempted: what
/// an error at @p position cost it. A position an earlier backward jump already
/// ran is no loss, and one before @p position a forward jump passed over was
/// the script's decision.
size_t count_steps_not_run (const std::vector<bool>& attempted, size_t position) {
    const auto after =
    std::next (attempted.begin (), static_cast<std::ptrdiff_t> (position + 1));
    return static_cast<size_t> (std::count (after, attempted.end (), false));
}

/// Whether the bounded store keeps a step of @p outcome first: every step that
/// did not pass, except one the run's Stop cut short, which is no failure for
/// a reader to find (#3397).
bool kept_before_successes (StepOutcome outcome) {
    switch (outcome) {
    case StepOutcome::Passed:
    case StepOutcome::Stopped: return false;
    case StepOutcome::Failed:
    case StepOutcome::Skipped:
    case StepOutcome::Errored: return true;
    }
    return true;
}

/**
 * A sent step in the run's tallies, as the load path's `handle_result` counts
 * a completion: its status, its failed `mcp` reply's class (#3828), its stream
 * and protocol, and its latency when its transfer ran.
 */
void tally_sent_step (const StepContext& ctx,
const vayu::Response& response,
const StepRecord& record,
ScenarioSummaryInputs& summary) {
    // A failed reply under a 2xx or 3xx goes under `0`, where the load path's
    // `record_error` puts it, so the error rate and its budget count it; the
    // step's row and coverage keep the status the server sent.
    const bool failed_behind_success =
    vayu::http::mcp_failure_behind_success_status (response) != nullptr;
    ++summary.status_codes[failed_behind_success ? 0 : record.status_code];
    if (const auto& reply = response.mcp_reply) {
        if (const auto& error_class = reply->error_class) {
            summary.error_classes.record (*error_class, reply->code);
        }
    }
    if (const auto completion = stream_completion_of (response)) {
        ctx.context->metrics_collector->record_stream_completion (*completion);
    }
    if (response.http_version_downgraded) {
        ++summary.http_version_downgraded;
    }
    if (response.transfer_attempted) {
        summary.latencies.push_back (record.latency_ms);
    }
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
        // `build_result_trace` writes for a default `Response` would read in
        // the expanded view as a server answering nothing. The row keeps the
        // request, what the step amounted to.
        record.trace.erase ("response");
    }
    stamp_step_identity (record.trace, record);
    if (record.script_ms) {
        record.trace["scriptMs"] = *record.script_ms;
    }
    vayu::json::cap_trace_bodies (record.trace, ctx.max_trace_body_bytes);
    // A streaming step's events (#3235), parsed back out of the body as a load
    // sample's are (`GET /runs/:id/samples`), into the `events` node a design
    // stream's trace carries. After the body cap, as there: the list carries
    // its own bound and reads the whole held body.
    if (const auto& events = exchange.response.stream_events; exchange.sent && events) {
        const auto& text_path = exchange.response.stream_text_path;
        record.trace["events"] =
        vayu::http::buffered_stream_events_node (exchange.response.body, ctx.sse_limits,
        static_cast<int64_t> (*events), !exchange.response.body_truncated,
        std::nullopt, text_path ? &text_path->steps : nullptr);
    }

    // What the scripts produced, on the node design mode writes and
    // `restore-response.ts` reads (#724); otherwise a step's detail could show
    // only `classify_step`'s one-line summary, where the same request sent
    // alone shows every assertion.
    //
    // After the body cap for `record_design_result`'s reason:
    // `cap_trace_bodies` walks only the request and response body nodes, so
    // writing this after it cannot be misread as covered. Only when the scripts
    // said something: an empty node would put a Tests pane of nothing on every
    // stored step.
    if (auto scripts = vayu::http::routes::build_script_result_node (
        exchange.pre_script_result, exchange.post_script_result, ctx.max_trace_body_bytes);
    !scripts.empty ()) {
        record.trace["scripts"] = std::move (scripts);
    }
    // Every compiled element's outcome (#1514), `step.before` / `step.after` /
    // `step.between` alike: the per-element detail beside the one-line summary,
    // `assert.*` failures already being in `scripts` above
    // (`describe_failed_tests` reads the `tests` list `pm.test` writes to).
    if (!record.elements.empty ()) {
        nlohmann::json elements = nlohmann::json::array ();
        for (const auto& outcome : record.elements) {
            elements.push_back (outcome.to_json ());
        }
        record.trace["elements"] = std::move (elements);
    }
    // Extractions that found nothing and unset their variable (#3053), so a
    // stale-value suspect does not need the list read through. Absent at 0.
    if (const size_t misses = vayu::core::count_extractor_misses (record.elements);
    misses > 0) {
        record.trace["extractorMisses"] = misses;
    }
    // Names the request carried to the wire unanswered (#3248), absent at 0.
    if (record.unresolved_tokens > 0) {
        record.trace["unresolvedTokens"] = record.unresolved_tokens;
    }

    ++summary.steps_executed;
    // Only a step that sent counts towards coverage and the run's threshold
    // inputs (#1564): a skipped step exercised no operation, so it belongs in
    // neither an error-rate denominator nor a latency percentile. A step
    // refused at the wire's edge (the residual pass, the file rule, the
    // pre-send gate) is an errored request with no duration, counted but not
    // timed; a transport failure that ran keeps its duration, the load path's
    // population (#2384). A stopped step is in neither, as a load run's
    // stop-cancelled request is not (#2136, #3397).
    if (exchange.sent && record.outcome != StepOutcome::Stopped) {
        coverage.record (step.index, record.status_code);
        tally_sent_step (ctx, exchange.response, record, summary);
    }
    if (record.tests) {
        summary.assertions.passed += record.tests->passed;
        summary.assertions.failed += record.tests->failed;
    }
    switch (record.outcome) {
    case StepOutcome::Passed: ++summary.passed; break;
    case StepOutcome::Failed: ++summary.failed; break;
    case StepOutcome::Skipped: ++summary.skipped; break;
    case StepOutcome::Errored: ++summary.errored; break;
    case StepOutcome::Stopped: ++summary.stopped; break;
    }

    vayu::db::Result row;
    row.run_id      = ctx.context->run_id;
    row.timestamp   = runner_now_ms ();
    row.status_code = record.status_code;
    row.status_text = record.status_text;
    row.latency_ms  = record.latency_ms;
    row.error       = record.error;
    // A header value off the wire, or the wire request's body, can hold a
    // non-UTF-8 byte, which becomes U+FFFD instead of throwing (as in
    // store_result).
    row.trace_data =
    record.trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    store.add (std::move (row), kept_before_successes (record.outcome));

    ctx.context->append_tick (
    build_step_payload (record, ctx.context->published_count.load ()));
}

/**
 * `step.between` (#1514): `timer.think` and anything else phased here run after
 * the step's outcome is decided, so a wait never counts against its latency,
 * and before flow control reads it, so a `Stop` mid-wait ends the run promptly,
 * not after one more step. Called only for a step whose row bound and did not
 * already error.
 *
 * `between_control` is read, not discarded: `control.loop` (#1515) is the one
 * `step.between` kind that can decide where the iteration goes, through
 * `ScriptControl`, the step's chronologically latest decision and so the one
 * "last call wins" favours.
 *
 * `control.transaction`'s `includeTimers` (#1569) folds this step's
 * between-phase wait into an *open* transaction's running sum;
 * `fold_between_wait_into_open_transactions` says why "open" excludes the
 * folder's last member.
 */
void run_step_between (const StepContext& base,
const ScenarioStep& step,
vayu::http::routes::ExchangeOutcome& exchange,
StepRecord& record) {
    vayu::ScriptResult between_control;
    vayu::ScriptResult unread_post;
    vayu::core::ElementContext between_ctx{
        .request        = exchange.request,
        .response       = nullptr,
        .run_pre_script = [] (
                          const std::string&) { return vayu::ScriptResult{}; },
        .run_post_script = [] (
                           const std::string&) { return vayu::ScriptResult{}; },
        .pre_script_result  = between_control,
        .post_script_result = unread_post,
        .set_variable = [] (std::string_view, const std::string&, const std::string&) {},
        .should_stop = [&] { return base.context->should_stop.load (); },
        .iteration        = base.iteration,
        .step_position    = step.index,
        .element_spans    = &base.element_spans,
        .controller_state = &base.controller_state,
        .rng              = &base.context->rng,
        .pacing_state     = &base.context->pacing_state,
        .timers_override  = &base.context->timers_override,
        .record_metric    = nullptr, // metric.record is step.after only.
    };
    const size_t between_start = record.elements.size ();
    vayu::core::ElementPipeline::run (vayu::core::Phase::StepBetween,
    between_ctx, *step.elements, record.elements);
    if (between_control.control.kind != vayu::ScriptControl::Kind::None) {
        exchange.post_script_result.control = between_control.control;
    }

    int64_t between_wait_ms = 0;
    for (size_t i = between_start; i < record.elements.size (); ++i) {
        between_wait_ms += record.elements[i].waited_ms.value_or (0);
    }
    if (between_wait_ms > 0) {
        vayu::core::fold_between_wait_into_open_transactions (*step.elements,
        base.element_spans, step.index, base.iteration, between_wait_ms,
        base.controller_state);
    }
}

/// `control.transaction` (#3054): settles every transaction @p step is a member
/// of once the step's outcome and the iteration's next position are known
/// (`settle_transactions`, the load path's rule too), and records each pass
/// that closed here. A close is the one outcome carrying `duration_us`, its
/// declared name in `message`.
void settle_step_transactions (const StepContext& ctx,
const ScenarioStep& step,
const vayu::http::routes::ExchangeOutcome& exchange,
const std::string& data_bind_error,
std::optional<size_t> next_position,
StepRecord& record,
TransactionHistograms& transactions) {
    if (!step.elements) {
        return;
    }
    const bool bound            = data_bind_error.empty ();
    const bool assertion_failed = record.tests && record.tests->failed > 0;
    vayu::core::settle_transactions (*step.elements, ctx.element_spans,
    vayu::core::TransactionMember{
    .step_index = step.index,
    .iteration  = ctx.iteration,
    .attempted  = exchange.sent || !bound,
    .errored    = vayu::core::transaction_member_errored (
    bound ? &exchange.response : nullptr, assertion_failed),
    .next_position = next_position,
    },
    ctx.controller_state, record.elements);
    for (const auto& outcome : record.elements) {
        if (outcome.duration_us && outcome.message) {
            transactions.record (
            *outcome.message, *outcome.duration_us, outcome.status == "failed");
        }
    }
}

/**
 * One iteration: a walk over the plan, not a pass through it. A script may send
 * it backwards, forwards or out early, so the position is a variable and the
 * loop is bounded by the per-iteration budget, not the plan's length.
 *
 * @return the plan positions an errored step's end of the iteration cost it
 *         (`count_steps_not_run`); 0 for an iteration that ended any other way.
 */
size_t run_iteration (vayu::runtime::ScriptEngine& script_engine,
vayu::http::CookieJar* cookie_jar,
const std::string& cookie_scope,
vayu::http::routes::RunVariableScopes& scopes,
const StepContext& base,
const ScenarioPlan& plan,
const ScenarioStepIndex& step_index,
size_t max_steps_per_iteration,
CoverageTally& coverage,
ScenarioSummaryInputs& summary,
ScenarioStepStore& store,
TransactionHistograms& transactions) {
    size_t position             = 0;
    size_t steps_this_iteration = 0;
    std::deque<std::string> recent_steps;
    std::vector<bool> attempted (plan.steps.size (), false);

    while (position < plan.steps.size ()) {
        // Checked per step, not per iteration: a 50-step iteration
        // would otherwise keep sending for minutes after the stop.
        if (base.context->should_stop) {
            break;
        }

        const auto& step = plan.steps[position];

        vayu::http::routes::ExchangeOutcome exchange;
        const StepContext& step_ctx = base;
        const std::string data_bind_error = run_step_exchange (script_engine, cookie_jar,
        cookie_scope, scopes.bind (step.collection_id), step_ctx, step, exchange);

        ++steps_this_iteration;
        attempted[position] = true;
        recent_steps.push_back (step.name);
        if (recent_steps.size () > CYCLE_TRAIL_LENGTH) {
            recent_steps.pop_front ();
        }

        StepRecord record =
        record_step (step_ctx, step, exchange, data_bind_error, summary);

        // The Stop cut this step short (#3397) and ends the run: nothing that
        // reads a finished step (`step.between`, flow control, `stopOnError`'s
        // count of positions lost, a transaction's close) reads this one.
        if (record.outcome == StepOutcome::Stopped) {
            store_step_record (step_ctx, step, exchange, record, coverage, summary, store);
            return 0;
        }

        // `step.between` (#1514); `run_step_between` says when and why. Skipped
        // for a step whose row could not bind or that already errored.
        if (data_bind_error.empty () &&
        record.outcome != StepOutcome::Errored && step.elements) {
            run_step_between (base, step, exchange, record);
        }

        bool end_iteration   = false;
        size_t next_position = position + 1;
        if (record.outcome == StepOutcome::Errored) {
            // Postman's default (issue #2526): an errored step - a script that
            // threw, a transport failure, a row that would not bind - is a red
            // row and the iteration moves on; `stopOnError` ends it instead.
            end_iteration = base.stop_on_error;
        } else {
            next_position = decide_next_step (exchange, step_index, recent_steps, position,
            steps_this_iteration, max_steps_per_iteration, record, end_iteration);
        }
        // Read after `decide_next_step`, which can itself error the step.
        const bool ended_by_error = end_iteration && record.outcome == StepOutcome::Errored;
        if (ended_by_error) {
            record.steps_not_run = count_steps_not_run (attempted, position);
        }
        settle_step_transactions (step_ctx, step, exchange, data_bind_error,
        end_iteration ? std::nullopt : std::optional (next_position), record, transactions);

        store_step_record (step_ctx, step, exchange, record, coverage, summary, store);

        if (ended_by_error) {
            vayu::utils::log_warning ("run",
            "Scenario run: iteration " + std::to_string (base.iteration) +
            " ended at step '" + record.step_name + "'",
            { { "runId", base.context->run_id },
            { "stepError", vayu::utils::bounded_log_text (record.error) } });
            return record.steps_not_run;
        }
        if (end_iteration) {
            break;
        }
        position = next_position;
    }
    return 0;
}

namespace {

/// @p origin's @p member when it is a string, else empty: a single-request
/// run's `lifecycleElements` entry carries whatever `origin` its client sent.
std::string origin_text (const nlohmann::json& origin, const char* member) {
    if (!origin.is_object ()) {
        return {};
    }
    const auto found = origin.find (member);
    return found != origin.end () && found->is_string () ? found->get<std::string> () :
                                                           std::string{};
}

/// The collection @p origin names, as a setup refusal leads with it:
/// `folder '<name>'` or `collection '<name>'`, the id standing in for a
/// missing name, and empty when it names neither.
std::string refusing_collection (const nlohmann::json& origin) {
    std::string label = origin_text (origin, "name");
    if (label.empty ()) {
        label = origin_text (origin, "id");
    }
    if (label.empty ()) {
        return {};
    }
    const char* level = origin_text (origin, "scope") == "folder" ? "folder" : "collection";
    return std::string (level) + " '" + label + "'";
}

} // namespace

std::optional<std::string>
lifecycle_refusal (const std::vector<vayu::core::ElementOutcome>& outcomes, size_t first) {
    for (size_t i = first; i < outcomes.size (); ++i) {
        const auto& outcome = outcomes[i];
        if (outcome.status != "error" && outcome.status != "failed") {
            continue;
        }
        std::string refusal = refusing_collection (outcome.origin);
        if (!refusal.empty ()) {
            refusal += ": ";
        }
        refusal += outcome.message.value_or ("unknown error");
        return refusal;
    }
    return std::nullopt;
}

void run_setup_elements (vayu::runtime::ScriptEngine& script_engine,
vayu::http::routes::ScriptVariableScopes& scopes,
const vayu::runtime::ScriptSendInputs& script_send,
const std::vector<vayu::core::CompiledElement>& elements,
std::vector<vayu::core::ElementOutcome>& setup_outcomes) {
    vayu::Request lifecycle_request;
    vayu::ScriptResult unread_pre;
    vayu::ScriptResult unread_post;
    vayu::core::ElementContext setup_ctx{
        .request        = lifecycle_request,
        .response       = nullptr,
        .run_pre_script = [] (
                          const std::string&) { return vayu::ScriptResult{}; },
        .run_post_script = [] (
                           const std::string&) { return vayu::ScriptResult{}; },
        .pre_script_result  = unread_pre,
        .post_script_result = unread_post,
        .set_variable = [] (std::string_view, const std::string&, const std::string&) {},
        .should_stop   = nullptr,
        .record_metric = nullptr, // metric.record is step.after only.
        .run_setup_script =
        [&] (const std::string& script) {
            auto script_ctx = vayu::runtime::ScriptContext::for_setup ();
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            script_send.apply (script_ctx);
            return vayu::http::routes::execute_script (
            script_engine, script, script_ctx, "Setup");
        },
    };
    vayu::core::ElementPipeline::run (
    vayu::core::Phase::RunStart, setup_ctx, elements, setup_outcomes);
}

void run_teardown_elements (vayu::runtime::ScriptEngine& script_engine,
vayu::http::routes::ScriptVariableScopes& scopes,
const vayu::runtime::ScriptSendInputs& script_send,
const std::vector<vayu::core::CompiledElement>& elements,
const vayu::runtime::RunSummaryInfo& run_summary_info,
std::vector<vayu::core::ElementOutcome>& teardown_outcomes) {
    vayu::Request lifecycle_request;
    vayu::ScriptResult unread_pre;
    vayu::ScriptResult unread_post;
    vayu::core::ElementContext teardown_ctx{
        .request        = lifecycle_request,
        .response       = nullptr,
        .run_pre_script = [] (
                          const std::string&) { return vayu::ScriptResult{}; },
        .run_post_script = [] (
                           const std::string&) { return vayu::ScriptResult{}; },
        .pre_script_result  = unread_pre,
        .post_script_result = unread_post,
        .set_variable = [] (std::string_view, const std::string&, const std::string&) {},
        .should_stop   = nullptr,
        .record_metric = nullptr, // metric.record is step.after only.
        .run_teardown_script =
        [&] (const std::string& script) {
            auto script_ctx = vayu::runtime::ScriptContext::for_teardown (run_summary_info);
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            script_send.apply (script_ctx);
            return vayu::http::routes::execute_script (
            script_engine, script, script_ctx, "Teardown");
        },
    };
    vayu::core::ElementPipeline::run (
    vayu::core::Phase::RunEnd, teardown_ctx, elements, teardown_outcomes);
}

std::optional<std::string> run_scenario_setup (vayu::runtime::ScriptEngine& script_engine,
vayu::http::routes::RunVariableScopes& scopes,
const vayu::runtime::ScriptSendInputs& script_send,
const std::vector<LifecycleCollection>& lifecycle,
std::vector<vayu::core::ElementOutcome>& setup_outcomes) {
    for (const auto& collection : lifecycle) {
        const size_t first = setup_outcomes.size ();
        run_setup_elements (script_engine, scopes.bind (collection.collection_id),
        script_send, collection.elements, setup_outcomes);
        if (auto refusal = lifecycle_refusal (setup_outcomes, first)) {
            return refusal;
        }
    }
    return std::nullopt;
}

std::vector<vayu::core::ElementOutcome> run_scenario_teardown (
vayu::runtime::ScriptEngine& script_engine,
vayu::http::routes::RunVariableScopes& scopes,
const vayu::runtime::ScriptSendInputs& script_send,
const std::vector<LifecycleCollection>& lifecycle,
const vayu::runtime::RunSummaryInfo& run_summary_info) {
    std::vector<vayu::core::ElementOutcome> teardown_outcomes;
    for (auto collection = lifecycle.rbegin (); collection != lifecycle.rend (); ++collection) {
        run_teardown_elements (script_engine, scopes.bind (collection->collection_id),
        script_send, collection->elements, run_summary_info, teardown_outcomes);
    }
    return teardown_outcomes;
}

namespace {

/// Step rows stored for @p run_id after a failed write. The write is chunked,
/// so chunks that landed before the failure stay: report those, not zero. A
/// database that cannot be read stores nothing as far as anyone can tell.
size_t stored_step_count (vayu::db::Database& db, const std::string& run_id) {
    try {
        return db.get_results_without_traces (run_id).size ();
    } catch (const std::exception&) {
        // @deliberate the database that refused the write cannot be counted
        // either; zero is the answer the summary gave before writes were chunked.
        return 0;
    }
}

/// The collections whose chains the run's scripts read: the run collection,
/// each of the lifecycle set's, for its setup and teardown, and every step's
/// own.
std::vector<std::string> scope_collection_ids (const ScenarioRequest& asked,
const ScenarioPlan& plan,
const std::vector<LifecycleCollection>& lifecycle) {
    std::vector<std::string> ids;
    ids.reserve (plan.steps.size () + lifecycle.size () + 1);
    ids.push_back (asked.collection_id);
    for (const auto& collection : lifecycle) {
        ids.push_back (collection.collection_id);
    }
    for (const auto& step : plan.steps) {
        ids.push_back (step.collection_id);
    }
    return ids;
}

/// The run's terminal move, which keeps the end_time stamped before the
/// summary. A row still Pending is one whose move to Running threw, which
/// failed the run; every other ending leaves Running.
void move_to_final_status (vayu::db::Database& db,
const std::string& run_id,
vayu::RunStatus final_status) {
    if (final_status == vayu::RunStatus::Failed) {
        db.transition_run_status (run_id,
        { vayu::RunStatus::Pending, vayu::RunStatus::Running }, final_status);
        return;
    }
    db.transition_run_status (run_id, { vayu::RunStatus::Running }, final_status);
}

/// A throw after teardown leaves its lifecycle node in place; any earlier one,
/// a refusing setup included, reports what setup recorded (#3455).
void keep_or_report_setup (nlohmann::json& lifecycle,
const std::vector<vayu::core::ElementOutcome>& setup_outcomes) {
    if (lifecycle.empty ()) {
        lifecycle = vayu::core::build_lifecycle_node (setup_outcomes, {});
    }
}

} // namespace

void execute_scenario_run (const std::shared_ptr<RunContext>& context,
const std::shared_ptr<const ScenarioExecution>& execution,
vayu::db::Database* db_ptr,
vayu::http::CookieJar* cookie_jar,
RunManager& manager) {
    auto& db          = *db_ptr;
    const auto& plan  = execution->plan;
    const auto& asked = execution->request;

    ScenarioSummaryInputs summary;
    summary.iterations_requested = asked.iterations;
    const auto started_at        = std::chrono::steady_clock::now ();
    vayu::RunStatus final_status = vayu::RunStatus::Completed;

    // Built before the first send and read after the last, so a run that throws
    // mid-sequence still reports the operations it exercised. Inactive for a
    // collection bound to nothing: it records and builds nothing (#629).
    CoverageTally coverage = make_coverage_tally (*execution);

    // Whether the contract gates this run, read once: a property of who asked
    // for the run, as `allowScriptRequests` is; re-read per step it could not
    // change but could be got wrong twice.
    const bool fail_on_schema_error = read_fail_on_schema_error (context->config);
    summary.fail_on_schema_error = fail_on_schema_error;
    const bool stop_on_error     = read_stop_on_error (context->config);
    summary.stop_on_error        = stop_on_error;

    // The run's one parse of the schema index, before the first send, not per
    // step. `std::nullopt` (an unbound collection, a document with no index,
    // one that will not parse) is "not measured", never an empty contract that
    // passes every body; `validate_step_response` turns it into the reason the
    // binding recorded.
    const auto schema_index = ResponseSchemaIndex::parse (execution->spec.response_schemas);

    // Outside the `try` so a failing setup's outcome reaches the report from
    // the `catch` below (#3455).
    std::vector<vayu::core::ElementOutcome> setup_outcomes;
    try {
        // Only from Pending (#3340): a Stop that reached the row before this
        // run registered found no context and left it Stopped, and a deleted
        // row is gone. Either way the run ends here, running no step and
        // writing no status over the one that refused it.
        if (!db
            .transition_run_status (context->run_id,
            { vayu::RunStatus::Pending }, vayu::RunStatus::Running)
            .applied) {
            context->is_running = false;
            context->closed.store (true, std::memory_order_release);
            manager.retain_run (context->run_id);
            return;
        }

        // The jar every step reads and writes: one per environment, so "log in
        // on step 1, reuse the session on step 2" is the jar's own behaviour,
        // nothing this runner adds.
        std::optional<std::string> environment_id;
        if (auto it = context->config.find ("environmentId");
        it != context->config.end () && it->is_string () &&
        !it->get<std::string> ().empty ()) {
            environment_id = it->get<std::string> ();
        }
        const std::string cookie_scope =
        environment_id.value_or (std::string (vayu::http::NO_ENVIRONMENT_SCOPE));

        // Resolved once, here, and walked again in reverse by teardown, so a
        // folder added, moved or trashed mid-run changes neither end (#3456).
        const auto lifecycle =
        resolve_lifecycle_collections (db, asked.collection_id, asked.recursive);

        // Loaded once, mutated by every step, persisted once at the end. Each
        // step reads its own folder's chain, as a Send of its request does
        // (#3248), and each lifecycle collection's setup and teardown its own.
        vayu::http::routes::RunVariableScopes scopes (
        db, environment_id, scope_collection_ids (asked, plan, lifecycle));

        vayu::runtime::ScriptConfig script_config = vayu::core::read_script_config (db);
        // Payload-level, exactly as `POST /execute` reads it: whether a script
        // may send is a property of who asked for this run.
        script_config.allow_send_request =
        vayu::http::read_allow_script_requests (context->config);
        // Every step stores its trace, and the setup and teardown rows their
        // lifecycle node, so their scripts' requests ride them (#3633).
        vayu::core::record_script_requests (script_config, db);

        // One engine for the run: QuickJS contexts are pooled and reset per
        // execution, so a per-step engine would pay a runtime setup per step
        // for nothing.
        vayu::runtime::ScriptEngine script_engine (script_config);

        const auto max_trace_body_bytes = static_cast<size_t> (db.get_config_int (
        "maxTraceBodyBytes", static_cast<int> (constants::json::MAX_TRACE_BODY_BYTES)));
        // Run-scoped, like every read-once property above: steps that left by
        // different routes (#705, epic decision 3 of #704), added different
        // headers (#1229) or read a different bound (#1157) because Settings
        // changed mid-sequence would make the run unreproducible. A step is a
        // design-mode send, so the headers take the design scope's compression
        // setting and the bound is the design one. Every step's send reads
        // these, as does a `script.setup` / `script.teardown` `pm.sendRequest`,
        // with the run's timeout as the steps' requests carry it (#2841) and
        // the run's Stop as its cancel (#3371).
        const vayu::runtime::ScriptSendInputs script_send{
            .transport       = vayu::http::resolve_transport_policy (db),
            .default_headers = vayu::http::resolve_default_header_policy (
            db, vayu::http::DefaultHeaderScope::Design),
            .max_response_bytes = vayu::http::routes::design_response_body_bound (db),
            .request_timeout_ms =
            vayu::http::routes::resolve_request_timeout_ms (context->config, db),
            .cancel = &context->should_stop,
            .stop   = &context->should_stop,
        };
        // Read once for the same reason (#1514): a step's `extract.json` /
        // `assert.jsonpath` must not read a different bound because Settings
        // changed mid-sequence.
        const auto max_element_body_bytes = vayu::http::routes::element_body_bound (db);
        const auto sse_limits = vayu::http::read_sse_limits (db);
        ScenarioStepStore store (
        static_cast<size_t> (db.get_config_int ("maxScenarioStoredSteps",
        static_cast<int> (constants::scenario::MAX_STORED_STEPS))));

        // Flow control's two supports, both fixed for the run: where a
        // `setNextRequest` target resolves to, and how far one iteration may
        // travel before a cycle is called a cycle.
        const auto step_index                = build_step_index (plan);
        const size_t max_steps_per_iteration = resolve_max_steps_per_iteration (
        db.get_config_int ("maxStepsPerIteration", 0), plan.steps.size ());

        // The rows this run was given, bound one per iteration. Empty is the
        // ordinary case and keeps `pm.iterationData` undefined throughout.
        const auto& data_rows = execution->data_rows;

        // `control.loop` / `control.transaction`'s supports (#1515): the
        // plan-wide span every scope-spanning kind reads to recognise its
        // folder's first or last member; one controller-state map for the run's
        // whole life (#1512's single implicit user, never cleared between
        // iterations, since `control.once` must survive them all); and one
        // histogram per declared transaction name, allocated up front so
        // recording takes no lock.
        const auto element_spans = compute_element_spans (plan);
        std::unordered_map<std::string, int64_t> controller_state;
        TransactionHistograms transactions (plan);

        // The run's resolved size, once, ahead of the first step (#1398). This
        // run publishes no `metrics` ticks to carry it as a load run carries
        // `requestsExpected`, so the frame is where the number lives; a watcher
        // connecting after its eviction from the ring reports no fraction
        // rather than a wrong one.
        context->append_event ("plan",
        build_plan_payload (plan.steps.size (), asked.iterations).dump ());

        // `script.setup` (#1499): the lifecycle set's once-per-run elements
        // (never inherited per step, which `collection_only` refuses at write
        // time), on the `scopes` and `script_engine` every step's scripts
        // share, so a setup write is visible to step 1 as a prior step's would
        // be.
        if (auto setup_failure = run_scenario_setup (
            script_engine, scopes, script_send, lifecycle, setup_outcomes)) {
            throw std::runtime_error ("script.setup failed: " + *setup_failure);
        }

        context->advance_phase (RunPhase::sending);
        for (size_t iteration = 0; iteration < asked.iterations; ++iteration) {
            if (context->should_stop) {
                break;
            }

            // Row `i % rows` binds to iteration `i`. An explicit `iterations`
            // above the row count wraps rather than running short, and every
            // record carries the index so the wrap is visible.
            std::optional<size_t> data_row_index;
            if (!data_rows.empty ()) {
                data_row_index = iteration % data_rows.size ();
            }

            // Bounded by the budget above, not the plan's length
            // (`run_iteration` says why).
            const StepContext step_ctx{ context, execution, schema_index,
                script_send.transport, script_send.default_headers, cookie_scope,
                data_rows, data_row_index, iteration, asked.iterations,
                fail_on_schema_error, stop_on_error, max_trace_body_bytes,
                script_send.max_response_bytes, max_element_body_bytes,
                element_spans, controller_state, &db, sse_limits };
            summary.steps_not_run += run_iteration (script_engine, cookie_jar,
            cookie_scope, scopes, step_ctx, plan, step_index,
            max_steps_per_iteration, coverage, summary, store, transactions);

            if (!context->should_stop) {
                ++summary.iterations_completed;
            }
        }
        // No drain: a step's send has finished before the loop moves on, so a
        // Stop from here on finds nothing left to cut short.
        context->advance_phase (RunPhase::summarising);

        summary.steps_dropped = store.dropped ();
        summary.transactions  = transactions.build ();
        auto rows             = store.take ();
        summary.steps_stored  = rows.size ();
        try {
            db.add_results_batch (rows);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("run",
            "Failed to store scenario step results: " + std::string (e.what ()),
            { { "runId", context->run_id } });
            summary.steps_stored = stored_step_count (db, context->run_id);
        }

        final_status = context->stop_decides_outcome () ? vayu::RunStatus::Stopped :
                                                          vayu::RunStatus::Completed;

        // `script.teardown`: `pm.info.run` reads this pass's totals, and a
        // throwing teardown never changes `final_status`, already decided above
        // (`ElementPipeline::run` turns the throw into the element's "error"
        // outcome).
        vayu::runtime::RunSummaryInfo run_summary_info;
        run_summary_info.requests_sent     = summary.steps_executed;
        run_summary_info.error_rate        = summary.steps_executed > 0 ?
        (static_cast<double> (summary.errored) / static_cast<double> (summary.steps_executed)) * 100.0 :
        0.0;
        run_summary_info.assertions_passed = summary.passed;
        run_summary_info.assertions_failed = summary.failed;

        auto teardown_send     = script_send;
        teardown_send.stop     = context->teardown_stop ();
        auto teardown_outcomes = run_scenario_teardown (
        script_engine, scopes, teardown_send, lifecycle, run_summary_info);
        summary.lifecycle =
        vayu::core::build_lifecycle_node (setup_outcomes, teardown_outcomes);

        // Once, at the very end and after teardown, so its variable writes are
        // saved with every step's (#3249): per-step persistence would be N x M
        // diff-and-write cycles against the DB mutex for a value only this
        // run's later steps read. Best-effort, as design mode's is.
        scopes.persist (db);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "Scenario run error",
        { { "runId", context->run_id },
        { "error", vayu::utils::bounded_log_text (e.what ()) } });
        final_status = vayu::RunStatus::Failed;
        keep_or_report_setup (summary.lifecycle, setup_outcomes);
    }

    // Everything below runs on every path, including the failed one: a run that
    // never reaches a terminal status is a run the app waits on forever.
    summary.duration_s =
    std::chrono::duration<double> (std::chrono::steady_clock::now () - started_at)
    .count ();
    summary.coverage = coverage.build ();
    summary.custom_metrics = context->metrics_collector->custom_metric_summaries ();
    summary.stream = context->metrics_collector->stream_totals ();

    // The verdict against the declared budgets (#1564), judged once off the
    // numbers just tallied, never re-derived: `engine/CLAUDE.md`'s "decide
    // once, from data in hand", here about not reading two snapshots of the
    // run's tallies, not about locking (this function runs on the run's single
    // worker thread). `RunSummaryInputs` is the load path's shape; a collection
    // run fills only what `evaluate_thresholds`'s metric table reads (latency,
    // status codes, MCP error classes, throughput, assertions) rather than
    // going through an adapter, which nothing in the engine has, since most of
    // its fields (peak concurrency, dropped requests, a load run's queue wait)
    // have no counterpart in this mode.
    summary.latency = summarize_latencies (summary.latencies);
    RunSummaryInputs threshold_inputs;
    // Off the status tally, not the latencies: a step refused before the wire
    // is a request with no duration.
    threshold_inputs.total_requests =
    vayu::count_status_failures (summary.status_codes).total;
    threshold_inputs.status_codes  = summary.status_codes;
    threshold_inputs.error_classes = summary.error_classes;
    threshold_inputs.latency       = summary.latency.percentiles;
    threshold_inputs.throughput    = summary.duration_s > 0 ?
    static_cast<double> (threshold_inputs.total_requests) / summary.duration_s :
    0.0;
    // Every step's assertions ran on every send, so the whole tally is the
    // exact population and nothing was sampled (#2892).
    if (summary.assertions.total () > 0) {
        AssertionPopulations populations;
        populations.exact           = summary.assertions;
        threshold_inputs.assertions = populations;
    }
    // `metric.record` / `pm.metrics` (#1500) share the collector
    // `summary.custom_metrics` was read from; without this a declared
    // `custom.<name>.<stat>` budget would report "no data" on a collection run
    // with the value in the summary.
    threshold_inputs.custom_metrics = summary.custom_metrics;
    // A stream budget reads the same section, over the same duration (#3235).
    threshold_inputs.stream          = summary.stream;
    threshold_inputs.test_duration_s = summary.duration_s;
    summary.thresholds = evaluate_thresholds (context->config, threshold_inputs);

    // A stopped run reports Stopped whatever the verdict, and a run that threw
    // keeps Failed for its reason: `failRun` judges only a run that reached its
    // natural end, the guard `finish_load_test` applies (`run_manager.cpp`).
    if (final_status == vayu::RunStatus::Completed && summary.thresholds &&
    summary.thresholds->failed > 0 && thresholds_fail_run (context->config)) {
        final_status = vayu::RunStatus::Failed;
    }

    try {
        db.update_run_end_time (context->run_id);
        db.update_run_summary (
        context->run_id, build_scenario_summary_payload (summary).dump ());
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "Failed to store scenario run summary: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    try {
        // Written after the summary, matching the load path: the terminal
        // status is what tells a polling client the report is ready.
        move_to_final_status (db, context->run_id, final_status);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run",
        "Failed to update scenario run status: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    try {
        db.prune_runs_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("run", "Run pruning failed: " + std::string (e.what ()),
        { { "runId", context->run_id } });
    }

    vayu::utils::log_debug ("run",
    std::string ("Scenario run ") + vayu::to_string (final_status),
    { { "runId", context->run_id }, { "stepsExecuted", summary.steps_executed },
    { "iterationsCompleted", summary.iterations_completed }, { "passed", summary.passed },
    { "failed", summary.failed }, { "errored", summary.errored } });

    context->is_running = false;
    // After the last step event, never before: a consumer treats `closed` as
    // "no more data is coming" and would otherwise stop one event short.
    context->closed.store (true, std::memory_order_release);
    manager.retain_run (context->run_id);
}

} // namespace vayu::core
