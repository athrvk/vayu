/**
 * @file tests/scenario_load_breakdown_test.cpp
 * @brief Load-mode scenario runs: per-step histograms, the summary's per-step breakdown,
 * recursive folder variables, and the deferred step scripts a run samples and replays.
 *
 * The `ScenarioLoadTest` fixture and its mock server are in `scenario_load_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "mock_server.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/http/client.hpp"

#include "scenario_load_fixture.hpp"

using nlohmann::json;
using vayu::tests::scenario_load::ScenarioLoadTest;
using vayu::tests::scenario_load::ScenarioMockServer;

// ============================================================================
// Per-step metrics
// ============================================================================

// One histogram per step, and the whole-run aggregate is their union: every
// completion is counted exactly once, in exactly one step.
TEST_F (ScenarioLoadTest, PerStepHistogramsPartitionTheRunsCompletions) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 2 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.step_count (), 3u)
    << "histograms are allocated once from the plan's step count";

    size_t union_of_steps = 0;
    for (size_t i = 0; i < state->steps.step_count (); ++i) {
        EXPECT_EQ (state->steps.completed (i), 5u) << "step " << i;
        EXPECT_EQ (state->steps.errors (i), 0u) << "step " << i;
        EXPECT_GT (state->steps.percentiles (i).p50, 0.0)
        << "step " << i << " recorded no latency";
        union_of_steps += state->steps.completed (i);
    }
    EXPECT_EQ (union_of_steps, context_->total_requests ())
    << "the per-step histograms and the run aggregate disagree about how many "
       "completions there were";
}

// A step no VU ever reached reports zeros, not the INT64_MAX an empty
// HdrHistogram answers `min` with.
TEST_F (ScenarioLoadTest, AnUnreachedStepReportsZeroesRatherThanAnEmptyHistogramsMin) {
    ScenarioMockServer server;
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.completed (2), 0u);
    const auto unreached = state->steps.percentiles (2);
    EXPECT_EQ (unreached.min, 0.0);
    EXPECT_EQ (unreached.max, 0.0);
}

// #2384: a step whose transfer ran and failed (here a timeout) joins its own
// histogram at its duration, so the step's p99 and the run's describe the same
// attempts, and `finish_step` still counts it once. Mutation check: drop the
// `record_failed_transfer` call in `record_step_response` and the step holds
// no samples and reports a 0 ms max beside a run p99 at the timeout.
TEST_F (ScenarioLoadTest, AStepThatTimedOutJoinsItsHistogramAtItsDuration) {
    vayu::tests::SlowMockServer upstream;
    constexpr int64_t TIMEOUT_MS = 300;
    auto execution = plan_over ({ upstream.fast_url (), upstream.hang_url () });
    execution.plan.steps[1].request.timeout_ms = TIMEOUT_MS;

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.no_response (1), 3u)
    << "the hanging step did not time out";
    EXPECT_EQ (state->steps.completed (1), 3u)
    << "a failed transfer was counted as executed more than once";
    EXPECT_EQ (state->steps_executed.load (), 6u);
    EXPECT_EQ (state->steps.latency_samples (1), 3u);
    const auto timed_out = state->steps.percentiles (1);
    EXPECT_GE (timed_out.min, 0.9 * static_cast<double> (TIMEOUT_MS))
    << "a timed-out step's duration is about its timeout";

    auto& collector = *context_->metrics_collector;
    EXPECT_EQ (collector.latency_samples (),
    state->steps.latency_samples (0) + state->steps.latency_samples (1))
    << "the run's histogram and the steps' hold different attempts";
    const auto whole_run = collector.calculate_percentiles ();
    EXPECT_NEAR (whole_run.p99, timed_out.p99, 0.001 * timed_out.p99);
    EXPECT_NEAR (whole_run.max, timed_out.max, 0.001 * timed_out.max);
}

// The other side of #2384's line: a step refused before the wire (a scheme
// nothing sends) is a noResponse error with no duration to record. Mutation
// check: record a failed transfer whether or not it ran and the step reports
// samples it never took.
TEST_F (ScenarioLoadTest, AStepRefusedBeforeTheWireRecordsNoLatency) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), "ftp://127.0.0.1/never-sent" });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.no_response (1), 2u)
    << "the ftp step was not refused";
    EXPECT_EQ (state->steps.completed (1), 2u);
    EXPECT_EQ (state->steps.latency_samples (1), 0u)
    << "a step that never reached the wire recorded a duration";
    EXPECT_EQ (state->steps.percentiles (1).max, 0.0);
    EXPECT_EQ (state->steps.latency_samples (0), 2u);
    EXPECT_EQ (context_->metrics_collector->latency_samples (), 2u);
}

// #2384, step 6: `control.transaction` always summed an errored member, and the
// run's histogram now holds that member's failed transfer too, so a mixed
// transaction (one answered member, one that timed out) and the run describe
// one set of attempts: the transaction is the sum of its members' durations.
TEST_F (ScenarioLoadTest, AMixedTransactionAgreesWithTheRunsHistogram) {
    vayu::tests::SlowMockServer upstream;
    auto execution = plan_over ({ upstream.fast_url (), upstream.hang_url () });
    execution.plan.steps[1].request.timeout_ms = 300;
    // One element id on both steps is one folder's inherited occurrence.
    for (auto& step : execution.plan.steps) {
        step.elements = vayu::tests::compiled_elements (
        { json{ { "id", "el_txn" }, { "kind", "control.transaction" },
        { "enabled", true }, { "config", { { "name", "checkout" } } } } });
    }

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);
    ASSERT_EQ (state->steps.no_response (1), 1u)
    << "the hanging member did not time out";

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary.contains ("transactions")) << summary.dump ();
    ASSERT_EQ (summary["transactions"].size (), 1u) << summary.dump ();
    const auto& transaction = summary["transactions"][0];
    EXPECT_EQ (transaction["count"], 1);
    EXPECT_EQ (transaction["errors"], 1);

    auto& collector = *context_->metrics_collector;
    ASSERT_EQ (collector.latency_samples (), 2u)
    << "the run's histogram left out the member that timed out";
    const auto whole_run = collector.calculate_percentiles ();
    const double members =
    state->steps.percentiles (0).max + state->steps.percentiles (1).max;
    // Both sides are microsecond sums read back through a histogram, each
    // within 0.1% above the true value.
    EXPECT_NEAR (transaction["latency"]["max"].get<double> (), members, 0.002 * members);
    EXPECT_NEAR (
    whole_run.max, state->steps.percentiles (1).max, 0.001 * whole_run.max);
}

// Contract coverage under load (issue #629). What this pins that the tally's
// own tests cannot: the completion callback records on the real event loop, so
// every virtual user's send lands on the right operation - and the count is
// exact rather than derived from the bounded store the mode thins.
TEST_F (ScenarioLoadTest, ALoadRunCountsEveryCompletionAgainstItsOperation) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].spec_operation =
    R"({"operationId":"listPets","method":"GET","path":"/pets"})";
    // Step 1 names no operation at all, so its sends land in the off-contract
    // tally rather than on a row they do not belong to.
    vayu::core::DeclaredOperation listed;
    listed.operation_id = "listPets";
    listed.method       = "GET";
    listed.path         = "/pets";
    listed.responses    = { "200", "404" };
    vayu::core::DeclaredOperation never;
    never.operation_id                 = "deletePet";
    never.method                       = "DELETE";
    never.path                         = "/pets/{petId}";
    never.responses                    = { "204" };
    execution.spec.spec_id             = "spec_1";
    execution.spec.declared_operations = { listed, never };

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto coverage = vayu::core::build_scenario_load_coverage (*state);
    ASSERT_FALSE (coverage.empty ()) << "a bound run must report coverage";
    EXPECT_EQ (coverage["operationsTotal"], 2);
    EXPECT_EQ (coverage["operationsCovered"], 1);
    // Three iterations, one send of step 0 each - exact, not a sample.
    for (const auto& row : coverage["operations"]) {
        if (row["path"] == "/pets") {
            EXPECT_EQ (row["sent"], 3);
            EXPECT_EQ (row["declaredHit"], json::array ({ "200" }));
            EXPECT_EQ (row["declaredMissed"], json::array ({ "404" }));
        }
    }
    EXPECT_EQ (coverage["undeclaredOperationRequests"], 3);
}

// The other half of the per-mode rule: a load run of an unbound collection - the
// overwhelming majority - writes no coverage at all rather than a contract of
// zero operations.
TEST_F (ScenarioLoadTest, AnUnboundLoadRunReportsNoCoverageAtAll) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_TRUE (vayu::core::build_scenario_load_coverage (*state).empty ());
}

// The breakdown carries each step's identity beside its numbers, and the
// summary keeps the keys the report route already reads for a scenario run.
TEST_F (ScenarioLoadTest, TheSummaryCarriesAPerStepBreakdownAndTheSharedScenarioKeys) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    // Shared with the design-mode runner's payload, so one report section
    // covers both executors.
    EXPECT_EQ (summary["iterations"], 2);
    EXPECT_EQ (summary["iterations_completed"], 2);
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 0);
    EXPECT_EQ (summary["passed"], 4);
    EXPECT_EQ (summary["failed"], 0);
    // This mode's own.
    EXPECT_EQ (summary["virtual_users"], 1);

    ASSERT_TRUE (summary["steps"].is_array ());
    ASSERT_EQ (summary["steps"].size (), 2u);
    EXPECT_EQ (summary["steps"][0]["index"], 0);
    EXPECT_EQ (summary["steps"][0]["name"], "step0");
    EXPECT_EQ (summary["steps"][0]["requestId"], "req_0");
    EXPECT_EQ (summary["steps"][0]["method"], "GET");
    EXPECT_EQ (summary["steps"][0]["executed"], 2);
    EXPECT_EQ (summary["steps"][0]["errors"], 0);
    EXPECT_EQ (summary["steps"][0]["httpErrors"], 0);
    EXPECT_EQ (summary["steps"][0]["noResponse"], 0);
    EXPECT_EQ (summary["steps"][1]["name"], "step1");
    EXPECT_TRUE (summary["steps"][0]["latency"].contains ("p99"));
}

// A load run resolves no residual pass over what it binds (issue #1503): a
// step whose URL still carries `{{missing}}` after composition sends it
// literally on every iteration, and the run counts rather than refuses it -
// both per step, in the breakdown, and once for the whole run, in the
// metrics collector the top-level `warnings` line reads. Mutation check:
// remove the `unresolved_token_names` scan in `submit_one` and this reds,
// because nothing else in the load path ever looks for a `{{`.
TEST_F (ScenarioLoadTest, AStepWithAnUnresolvedTokenCountsAndWarnsWithoutRefusingTheRun) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0") + "?token={{missing}}", server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0]["unresolvedTokens"], 2)
    << "both iterations of step0 carried the unresolved token";
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 0)
    << "step1 carries no token and must not be charged for step0's";

    EXPECT_EQ (context_->metrics_collector->unresolved_token_requests (), 2u);
    const auto names = context_->metrics_collector->unresolved_token_names ();
    ASSERT_EQ (names.size (), 1u);
    EXPECT_EQ (names[0], "missing");

    // Never refused: both requests were still sent and completed.
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 0);
}

// A recursive scenario load run reads each step's own folder (#3248). The
// writer's inline `script.pre` makes the plan defer every step's names to the
// send (#2521), so the residual pass answers them from the step's folder: the
// writer's `{{f}}` is its folder's, `{{shared}}` the run collection's above
// it, and its `pm.collectionVariables` reads and writes that folder. The write
// answers the later step in its sub-folder and not the one in a sibling
// folder, where `{{seen}}` is a genuine miss and is counted as one. Mutation
// check: bind every base to the run collection in `LoadScopeBases`'
// constructor (`run_scopes.bind (run_collection_id)`) and the writer sends
// `/row/{{f}}`.
TEST_F (ScenarioLoadTest, ARecursiveRunSendsAndScriptsEachStepWithItsOwnFoldersVariables) {
    ScenarioMockServer server;
    const auto folder = [this] (const std::string& id, std::optional<std::string> parent,
                        const std::string& variables, int order) {
        vayu::db::Collection collection;
        collection.id         = id;
        collection.name       = id;
        collection.parent_id  = std::move (parent);
        collection.variables  = variables;
        collection.order      = order;
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);
    };
    folder ("col_test", std::nullopt,
    R"({"shared":{"value":"from-parent","enabled":true}})", 0);
    folder ("fold", "col_test", R"({"f":{"value":"folder-value","enabled":true}})", 0);
    folder ("deep", "fold", "{}", 1);
    folder ("other", "col_test", "{}", 1);

    const auto save = [&] (const std::string& id,
                      const std::string& collection_id, const std::string& path,
                      const std::string& bearer, const json& elements) {
        vayu::db::Request request;
        request.id            = id;
        request.collection_id = collection_id;
        request.name          = id;
        request.method        = vayu::HttpMethod::GET;
        request.url           = server.url (path);
        request.headers       = json::array (
        { { { "key", "Authorization" }, { "value", bearer }, { "enabled", true } } })
                          .dump ();
        request.elements   = elements.dump ();
        request.created_at = 1;
        request.updated_at = 1;
        db_->save_request (request);
    };
    save ("writer", "fold", "/row/{{f}}", "Bearer {{shared}}",
    json::array ({ vayu::tests::script_element_json ("el_pre",
    "script.pre", "pm.collectionVariables.set('seen', String(pm.collectionVariables.get('f')));",
    /*inline_script=*/true) }));
    save ("reader", "deep", "/row/deep", "Bearer {{seen}}", json::array ());
    save ("sibling", "other", "/row/other", "Bearer {{seen}}", json::array ());

    vayu::core::ScenarioResolveOptions options;
    options.timeout_ms           = 5000;
    options.limits.max_steps     = 10;
    options.limits.max_data_rows = 100;
    options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
    auto resolved = vayu::core::resolve_scenario (*db_,
    json{ { "source", "collection" }, { "collectionId", "col_test" }, { "recursive", true } },
    options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    vayu::core::ScenarioExecution execution;
    execution.request = std::move (resolved.request);
    execution.plan    = std::move (resolved.plan);
    ASSERT_EQ (execution.plan.steps.size (), 3u);

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution, /*pool_size=*/1);

    const auto writer  = server.hits_for ("/row/folder-value");
    const auto reader  = server.hits_for ("/row/deep");
    const auto sibling = server.hits_for ("/row/other");
    std::string sent;
    for (const auto& hit : server.hits ()) {
        sent += hit.path + " ";
    }
    ASSERT_EQ (writer.size (), 1u)
    << "the writer did not send its folder's {{f}}: " << sent;
    ASSERT_EQ (reader.size (), 1u);
    ASSERT_EQ (sibling.size (), 1u);
    EXPECT_EQ (writer[0].authorization, "Bearer from-parent");
    EXPECT_EQ (reader[0].authorization, "Bearer folder-value")
    << "the sub-folder did not read its parent folder's write";
    EXPECT_EQ (sibling[0].authorization, "Bearer {{seen}}")
    << "a sibling folder read another's write";

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0]["unresolvedTokens"], 0);
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 0);
    EXPECT_EQ (summary["steps"][2]["unresolvedTokens"], 1);
    const auto names = context_->metrics_collector->unresolved_token_names ();
    ASSERT_EQ (names.size (), 1u);
    EXPECT_EQ (names[0], "seen");
}

// An un-inlined pre-request script never runs under load (see
// `scenario_load_test.cpp`'s header comment on the executor); the breakdown
// says so per step instead of leaving the report silent about it, and a step
// with no script carries no such key. Mutation check: drop the `step_has_deferred_script` check in
// `build_step_breakdown` and step0's entry loses the field.
TEST_F (ScenarioLoadTest, AStepCarryingAPreRequestScriptReportsItSkippedInTheBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_pre_script (
    "pm.environment.set('x', '1');");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0]["preRequestScript"], "skipped");
    EXPECT_FALSE (summary["steps"][1].contains ("preRequestScript"))
    << "a step with no pre-request script must not report one as skipped";
}

// The run-level `pre_request_script_skipped` warning and the per-step
// `preRequestScript` marker read one rule (issue #1938): a `script.pre` that ran
// inline is neither warned about nor marked, one that did not is both. Driven
// through the real executor so the mode reaches the summary the way production
// hands it over. Mutation check: make `step_has_deferred_script` ignore its
// mode (back to `step_has_script`) and the two inline cases red.
class PreScriptSkippedTest : public ScenarioLoadTest {
    protected:
    /// Run a two-step plan whose step 0 carries a non-blank `script.pre`,
    /// marked inline or not, under @p scripts_mode (an `elements.scripts` value,
    /// empty for a payload that names none).
    std::shared_ptr<vayu::core::ScenarioLoadState> run_with_pre_script (
    ScenarioMockServer& server,
    bool marked_inline,
    const std::string& scripts_mode) {
        auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
        execution.plan.steps[0].elements =
        vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
        "el_pre", "script.pre", "pm.environment.set('x', '1');", marked_inline) });
        execution_ = execution;

        json config = { { "mode", "iterations" }, { "iterations", 1 },
            { "concurrency", 1 } };
        if (!scripts_mode.empty ()) {
            config["elements"] = { { "scripts", scripts_mode } };
        }
        return run (config, execution_);
    }

    /// The `pre_request_script_skipped` entries of the run's `warnings` array.
    json skipped_warnings () const {
        json found = json::array ();
        for (const auto& warning : vayu::core::build_run_warnings (context_)) {
            if (warning["code"] == "pre_request_script_skipped") {
                found.push_back (warning);
            }
        }
        return found;
    }

    json step0_breakdown (const vayu::core::ScenarioLoadState& state) const {
        return vayu::core::build_scenario_load_summary (
        state, execution_.plan)["steps"][0];
    }

    vayu::core::ScenarioExecution execution_;
};

TEST_F (PreScriptSkippedTest, AnUnmarkedPreScriptUnderAsMarkedIsWarnedAndMarkedSkipped) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/false, "asMarked");

    const auto warnings = skipped_warnings ();
    ASSERT_EQ (warnings.size (), 1u) << warnings.dump ();
    EXPECT_EQ (warnings[0]["steps"], 1);
    EXPECT_EQ (step0_breakdown (*state)["preRequestScript"], "skipped");
}

TEST_F (PreScriptSkippedTest, AllInlineRunsAnUnmarkedPreScriptSoNothingIsWarnedOrMarked) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/false, "allInline");

    EXPECT_TRUE (skipped_warnings ().empty ()) << skipped_warnings ().dump ();
    const auto step0 = step0_breakdown (*state);
    EXPECT_FALSE (step0.contains ("preRequestScript")) << step0.dump ();
    ASSERT_TRUE (step0.contains ("elements")) << step0.dump ();
    EXPECT_EQ (step0["elements"][0]["kind"], "script.pre");
    EXPECT_EQ (step0["elements"][0]["passed"], 1)
    << "the script ran, so the breakdown reports its real outcome";
}

TEST_F (PreScriptSkippedTest, APreScriptMarkedInlineIsNotWarnedWhenTheRunNamesNoOverride) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/true, "");

    EXPECT_TRUE (skipped_warnings ().empty ()) << skipped_warnings ().dump ();
    EXPECT_FALSE (step0_breakdown (*state).contains ("preRequestScript"));
}

TEST_F (PreScriptSkippedTest, AllDeferredOverridesAnInlineMarkSoItIsWarnedAndMarked) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/true, "allDeferred");

    const auto warnings = skipped_warnings ();
    ASSERT_EQ (warnings.size (), 1u) << warnings.dump ();
    EXPECT_EQ (warnings[0]["steps"], 1);
    EXPECT_EQ (step0_breakdown (*state)["preRequestScript"], "skipped");
}

// A blank script is inert (#1609) and a step without the kind carries nothing
// to leave behind, so neither counts as deferred whatever the mode.
TEST (StepHasDeferredScript, CountsOnlyANonBlankScriptOfTheNamedKindThatDidNotRunInline) {
    using vayu::core::ScriptsOverrideMode;
    using vayu::core::step_has_deferred_script;
    vayu::core::ScenarioStep step;
    step.elements =
    vayu::tests::step_elements_with_pre_script ("pm.test('t', () => {});");
    EXPECT_TRUE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AsMarked));
    EXPECT_TRUE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AllDeferred));
    EXPECT_FALSE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AllInline));
    EXPECT_FALSE (step_has_deferred_script (step, "script.post", ScriptsOverrideMode::AsMarked))
    << "a step carrying only a script.pre has no deferred script.post";

    step.elements = vayu::tests::step_elements_with_pre_script ("   \n");
    EXPECT_FALSE (step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AsMarked))
    << "a blank script carries no behaviour to warn about";

    step.elements.reset ();
    EXPECT_FALSE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AsMarked));
}

// Scripts stay deferred: a load-mode scenario runs none of them inline, and the
// run acquires no run-level script to stand in for the steps' own. What it does
// acquire (issue #450) is a per-step sample store for the steps that carry one,
// which the deferred pass below replays against.
TEST_F (ScenarioLoadTest, AScenarioLoadRunRunsNoInlineScriptsAndSamplesOnlyScriptedSteps) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    // A step that carries scripts, so "none ran inline" is a property of the
    // executor rather than of an empty plan.
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_scripts (
    "pm.environment.set('x', '1');", "pm.test('t', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    EXPECT_TRUE (context_->test_scripts.empty ())
    << "a scenario load run must not acquire a run-level test script";
    const auto& mc = *context_->metrics_collector;
    EXPECT_EQ (mc.response_samples ().size (), 0u)
    << "a scenario run must not fill the run-level store - its scripts are per "
       "step";
    EXPECT_GT (mc.step_response_samples (0).size (), 0u)
    << "the step carrying a post-request script was never sampled, so its "
       "assertions can never be checked";
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u)
    << "a step with no script was sampled - a body-sized copy nothing will "
       "read";
}

// Issue #1500's acceptance criterion, the load-path half: a metric.record
// trend runs inline on every VU's `step.after` - declarative kinds always
// run there, unlike script.* - and lands in the run's own MetricsCollector,
// with a count equal to that step's completions.
TEST_F (ScenarioLoadTest, MetricRecordProducesCustomMetricsWithTheStepsCompletionCount) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { nlohmann::json{ { "id", "el_metric" }, { "kind", "metric.record" },
    { "config",
    { { "name", "ttfb2" }, { "type", "trend" }, { "source", { { "latency", true } } } } } } });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto summaries = context_->metrics_collector->custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    ASSERT_EQ (summaries->count ("ttfb2"), 1u);
    EXPECT_EQ (summaries->at ("ttfb2").type, vayu::core::CustomMetricType::Trend);
    EXPECT_EQ (summaries->at ("ttfb2").count, 5u);
}

// Issue #3780's acceptance criterion: a streaming step's `metric.record` with
// an `eventJsonpath` source records one sample per stream, from the last event
// the path matches. Mutation check: scan `read_last_matching_event` forwards
// and `max` reads 1.
TEST_F (ScenarioLoadTest, AnEventJsonPathMetricRecordsOneSamplePerStream) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/sse-usage") });
    execution.plan.steps[0].request.stream_bounds = vayu::StreamBounds{ 5000, 100 };
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { nlohmann::json{ { "id", "el_usage" }, { "kind", "metric.record" },
    { "config",
    { { "name", "completion_tokens" }, { "type", "trend" },
    { "source", { { "eventJsonpath", "$.usage.completion_tokens" } } } } } } });

    constexpr size_t ITERATIONS = 3;
    run (json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);

    ASSERT_EQ (server.hits_for ("/sse-usage").size (), ITERATIONS);
    const auto summaries = context_->metrics_collector->custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    ASSERT_EQ (summaries->count ("completion_tokens"), 1u);
    const auto& tokens = summaries->at ("completion_tokens");
    EXPECT_EQ (tokens.type, vayu::core::CustomMetricType::Trend);
    EXPECT_EQ (tokens.count, ITERATIONS)
    << "one sample per stream, not per event";
    // The trend's histogram reads 30 back as 30.015; the first event would be 1.
    EXPECT_NEAR (tokens.max, 30.0, 0.5);
    EXPECT_NEAR (tokens.p50, 30.0, 0.5);
}

// A plan whose steps assert nothing gets no stores at all, which is what keeps
// the report's section absent rather than showing zeros.
TEST_F (ScenarioLoadTest, APlanWithNoScriptsSamplesNothing) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_EQ (mc.step_response_samples (0).size (), 0u);
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u);
    EXPECT_EQ (mc.response_samples_dropped (), 0u)
    << "a step nothing will validate must not be counted as a thinned sample";

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    EXPECT_FALSE (validation.run.has_value ())
    << "a run that validated nothing must omit the section, not report zeros";
}

// Sampling is keyed per step, so the last step of a long plan is sampled even
// when the run budget is far smaller than the number of completions.
//
// Mutation-check: revert to the flat whole-run reservoir and every one of these
// stores is empty - the run's samples all land in `response_samples()`, where
// nothing can tell which step produced them.
TEST_F (ScenarioLoadTest, EveryScriptedStepIsSampledIncludingTheLast) {
    ScenarioMockServer server;
    // Four steps over three distinct paths - the plan is what is long here, not
    // the mock. Every step asserts, so every step competes for the budget.
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1"),
    server.url ("/s2"), server.url ("/echo") });
    for (auto& step : execution.plan.steps) {
        step.elements = vayu::tests::step_elements_with_post_script (
        "pm.test('ok', function () { });");
    }

    // A budget of exactly one slot per scripted step, so the split is what
    // decides coverage rather than a budget large enough to hide it.
    const json config = { { "mode", "iterations" }, { "iterations", 6 },
        { "concurrency", 1 }, { "max_response_samples", 4 },
        { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc  = *context_->metrics_collector;
    size_t retained = 0;
    for (size_t step = 0; step < execution.plan.steps.size (); ++step) {
        EXPECT_GT (mc.step_response_samples (step).size (), 0u)
        << "step " << step << " was never sampled, so its assertions are never checked";
        retained += mc.step_response_samples (step).size ();
    }
    EXPECT_LE (retained, 4u) << "the run budget was handed to each step whole "
                                "instead of split across them";
    EXPECT_GT (mc.response_samples_dropped (), 0u)
    << "24 completions into a 4-sample budget must report what was thinned";
}

// ============================================================================
// Deferred per-step script validation (issue #450)
// ============================================================================

// Each step's own `post_script` is replayed against that step's samples, and a
// step with no script reports no tallies at all.
TEST_F (ScenarioLoadTest, EachStepsScriptIsReplayedAgainstItsOwnSamples) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { pm.expect(pm.response.code).to.equal(200); "
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 2u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step)
    << "the scripted step reported no tallies, so its assertions went "
       "unchecked";
    EXPECT_EQ (first_step->sampled, 3u);
    EXPECT_EQ (first_step->passed, 3u);
    EXPECT_EQ (first_step->failed, 0u);
    EXPECT_FALSE (validation.steps[1].has_value ())
    << "a step with no script must report nothing rather than a row of zeros";

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->sampled, 3u);
    EXPECT_EQ (validation.run->passed, 3u);
}

// A failing assertion is attributed to the step that made it, not to the run -
// which is the whole reason the tallies are per step.
TEST_F (ScenarioLoadTest, AFailingAssertionIsAttributedToItsOwnStep) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { pm.expect(pm.response.code).to.equal(200); "
    "});");
    execution.plan.steps[1].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('wrong', function () { pm.expect(pm.response.code).to.equal(500); "
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 3u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->failed, 0u);
    EXPECT_EQ (first_step->passed, 2u);
    const auto& second_step = validation.steps[1];
    ASSERT_HAS_VALUE (second_step);
    EXPECT_EQ (second_step->failed, 2u)
    << "step 2's failing assertion was not attributed to step 2";
    EXPECT_EQ (second_step->passed, 0u);
    EXPECT_FALSE (validation.steps[2].has_value ());

    // The run's headline still says something failed; the breakdown says where.
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 2u);
    EXPECT_EQ (validation.run->passed, 2u);
}

// A script whose `pm.test` calls are a mix of passing and failing must not
// collapse to one opaque failure (issue #1502): every test result is tallied
// and every failure is named.
TEST_F (ScenarioLoadTest, AMixedPassAndFailScriptReportsBothTalliesAndNamesTheFailure) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('status is 200', function () { "
    "pm.expect(pm.response.code).to.equal(200); });"
    "pm.test('body has a unicorn', function () { "
    "pm.expect(undefined).to.equal('yes'); });");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 1u)
    << "the passing assertion was discarded once a sibling assertion failed";
    EXPECT_EQ (first_step->failed, 1u);

    const auto results = db_->get_results ("test-scenario-load");
    ASSERT_FALSE (results.empty ());
    const std::string& trace = results.back ().trace_data;
    EXPECT_NE (trace.find ("body has a unicorn: AssertionError: Expected "
                           "undefined to equal 'yes'"),
    std::string::npos)
    << trace;
    EXPECT_EQ (trace.find ("Script error: "), std::string::npos)
    << "a named assertion failure was reported as an opaque script error: " << trace;
}

// A script can run a test to completion and still throw afterwards - that is
// a second, distinct failure and must not vanish just because the test that
// already ran is tallied (issue #1502).
TEST_F (ScenarioLoadTest, AScriptThatThrowsAfterAPassingTestStillReportsTheThrow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { pm.expect(1).to.equal(1); });"
    "throw new Error('late boom');");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 1u)
    << "the test that ran before the throw was dropped";
    EXPECT_EQ (first_step->failed, 1u)
    << "the throw after the test was silently dropped";

    const auto results = db_->get_results ("test-scenario-load");
    ASSERT_FALSE (results.empty ());
    const std::string& trace = results.back ().trace_data;
    EXPECT_NE (trace.find ("Script error: "), std::string::npos) << trace;
    EXPECT_NE (trace.find ("late boom"), std::string::npos)
    << "the thrown message was dropped: " << trace;
}

// A script that throws before ever calling `pm.test` has no tests to tally,
// so it still takes the script-error path - but with the real thrown message,
// never an empty one (issue #1502).
TEST_F (ScenarioLoadTest, AThrowingScriptWithNoTestsNamesTheThrownMessage) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::step_elements_with_post_script ("throw new Error('boom');");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 0u);
    EXPECT_EQ (first_step->failed, 1u);

    const auto results = db_->get_results ("test-scenario-load");
    ASSERT_FALSE (results.empty ());
    const std::string& trace = results.back ().trace_data;
    EXPECT_NE (trace.find ("Script error: "), std::string::npos) << trace;
    EXPECT_NE (trace.find ("boom"), std::string::npos)
    << "the thrown message was dropped, leaving an empty \"Script error: \": " << trace;
}

// The replayed script reads the iteration it actually ran in and the data row
// that iteration was bound to - a real index, not a reservoir position.
TEST_F (ScenarioLoadTest, ADeferredStepScriptReadsItsIterationAndDataRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "a" } }, json{ { "id", "b" } } });
    // Two iterations bind rows 0 and 1, so a script that pairs the iteration
    // with its row passes only if both bindings are the real ones.
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('bound', function () {"
    "  var expected = pm.info.iteration === 0 ? 'a' : 'b';"
    "  if (pm.iterationData.get('id') !== expected) {"
    "    throw new Error('iteration ' + pm.info.iteration + ' saw ' +"
    "      pm.iterationData.get('id'));"
    "  }"
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 2u);
    EXPECT_EQ (first_step->failed, 0u);
}

// `pm.execution` still throws, naming itself: a script that has already run
// against a recorded response cannot redirect a sequence that already happened.
TEST_F (ScenarioLoadTest, PmExecutionStillThrowsInADeferredStepScript) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    // The assertion passes only if the call threw *and* the sentence named the
    // method - so a silently accepted call fails this test rather than reading
    // as a pass.
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('refused', function () {"
    "  var message = '';"
    "  try { pm.execution.setNextRequest('somewhere'); }"
    "  catch (e) { message = String(e && e.message ? e.message : e); }"
    "  if (message.indexOf('setNextRequest') === -1) {"
    "    throw new Error('not refused by name: ' + message);"
    "  }"
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 1u);
    EXPECT_EQ (first_step->failed, 0u);
}

// The tallies land on the step they belong to in the stored summary, which is
// what the report route hands the app verbatim.
TEST_F (ScenarioLoadTest, PerStepTalliesAreAttachedToTheStoredBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    auto state        = run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    auto summary =
    vayu::core::build_scenario_load_summary (*state, context_->scenario->plan);
    vayu::core::attach_step_test_totals (summary, validation.steps);

    ASSERT_TRUE (summary["steps"].is_array ());
    ASSERT_EQ (summary["steps"].size (), 2u);
    ASSERT_TRUE (summary["steps"][0].contains ("tests"));
    EXPECT_EQ (summary["steps"][0]["tests"]["sampled"], 2);
    EXPECT_EQ (summary["steps"][0]["tests"]["passed"], 2);
    EXPECT_EQ (summary["steps"][0]["tests"]["failed"], 0);
    EXPECT_FALSE (summary["steps"][1].contains ("tests"))
    << "a step that asserted nothing must carry no tests object at all";
}

// ============================================================================
// The element pipeline on the load paths (issue #1495)
// ============================================================================

// A declarative element (extract.json) always runs inline under load - no
// `inline` mark needed, only a `script.*` element opts in explicitly. Two VUs
// held inside `/login` at the same time must each carry their *own* login's
// token on their own step 1, never the other's - the correlation bug this
// issue exists to fix, proven the same way cookie isolation is proven above.
//
// Mutation check: remove the residual-token-pass call in `submit_one`, and
// step 1 sends the literal `{{token}}` for both VUs instead of either one's
// real value.
TEST_F (ScenarioLoadTest, AnInlineExtractCorrelatesPerVirtualUserAcrossSteps) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].authorization, echoes[1].authorization)
    << "both virtual users sent the same token - the extraction is shared "
       "rather than per-VU";
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0)
        << "no session reached step 1";
        const std::string session_id = echo.cookie.substr (4);
        EXPECT_EQ (echo.authorization, "Bearer tok-" + session_id)
        << "step 1 carried a token that does not match this VU's own login "
           "session - the two are not being bound to the same VU";
    }
}

// The same correlation, through an inline `script.post` instead of a
// declarative `extract.json` - proving the opt-in itself works, not just the
// overlay it writes through.
TEST_F (ScenarioLoadTest, AScriptPostMarkedInlineCorrelatesPerVirtualUserTheSameWayExtractDoes) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].authorization, echoes[1].authorization);
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0);
        EXPECT_EQ (echo.authorization, "Bearer tok-" + echo.cookie.substr (4));
    }
}
