/**
 * @file script_engine_execution_test.cpp
 * @brief pm.execution, pm.metrics, pm.iterationData and pm.response.events.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <array>
#include <cstddef>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

using vayu::tests::scenario_prerequest;
using vayu::tests::scenario_test;

// ============================================================================
// pm.execution - flow control (issue #355)
// ============================================================================
//
// The binding records an intent on the ScriptResult and reaches into nothing:
// only the scenario runner knows what a sequence is. These pin the value it
// records and, at least as importantly, every case where the call is refused -
// a binding that cannot fail is worse than a missing one (#188), and
// `setNextRequest("checkout")` quietly ignored in a single send is exactly the
// false success that rule exists to prevent.


TEST_F (ScriptEngineTest, SetNextRequestRecordsTheTargetOnTheResult) {
    auto ctx = scenario_test (request, response, env);
    auto result = engine.execute ("pm.execution.setNextRequest('checkout');", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Next);
    EXPECT_EQ (result.control.target, "checkout");
}

TEST_F (ScriptEngineTest, SetNextRequestNullEndsTheIteration) {
    auto ctx    = scenario_test (request, response, env);
    auto result = engine.execute ("pm.execution.setNextRequest(null);", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::EndIteration);
    EXPECT_TRUE (result.control.target.empty ());
}

// Postman's rule, and the only one that can be right: a script is a sequence of
// statements, so the last thing it said is what it meant.
TEST_F (ScriptEngineTest, TheLastFlowControlCallInAScriptWins) {
    auto ctx    = scenario_test (request, response, env);
    auto result = engine.execute (R"JS(
        pm.execution.setNextRequest('first');
        pm.execution.setNextRequest('second');
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Next);
    EXPECT_EQ (result.control.target, "second");
}

TEST_F (ScriptEngineTest, SkipRequestRecordsASkipFromAPreRequestScript) {
    auto ctx    = scenario_prerequest (request, env);
    auto result = engine.execute ("pm.execution.skipRequest();", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Skip);
}

// The request has already gone out by the time a test script runs, so there is
// nothing left to skip. Recording the intent and refusing it later would let
// the script believe it succeeded for the rest of its body.
TEST_F (ScriptEngineTest, SkipRequestThrowsInATestScript) {
    auto ctx    = scenario_test (request, response, env);
    auto result = engine.execute ("pm.execution.skipRequest();", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pre-request"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

// The single-send contract: `POST /execute` runs exactly this, and it has no
// next request to name and no scenario step to skip.
struct SingleSendExecutionCase {
    std::string_view case_name;
    std::string_view script;
};

class ScriptEngineSingleSendExecutionTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<SingleSendExecutionCase> {};

TEST_P (ScriptEngineSingleSendExecutionTest, ThrowsInASingleSend) {
    auto result =
    engine.execute_prerequest (std::string (GetParam ().script), request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

INSTANTIATE_TEST_SUITE_P (PerExecutionMethod,
ScriptEngineSingleSendExecutionTest,
::testing::Values (SingleSendExecutionCase{ "SetNextRequest", "pm.execution.setNextRequest('checkout');" },
SingleSendExecutionCase{ "SkipRequest", "pm.execution.skipRequest();" }),
[] (const ::testing::TestParamInfo<SingleSendExecutionCase>& info) {
    return std::string (info.param.case_name);
});

// QuickJS formats a thrown error into a fixed-size buffer (`JS_MakeError`,
// vendor/quickjs-ng/quickjs.c) and silently cuts whatever does not fit,
// mid-word - the longest `pm.execution` member name substituted into this
// message used to produce exactly that (issue #1503). Mutation check: widen
// the message text back out and this reds, on the truncated tail rather
// than the missing sentence.
TEST_F (ScriptEngineTest, SetNextRequestsRefusalIsNeverTruncatedMidWord) {
    auto result = engine.execute_prerequest (
    "pm.execution.setNextRequest('checkout');", request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (
               "docs/engine/scripting/execution-metrics-data.md."),
    std::string::npos)
    << "the message's own last sentence must survive whole: " << result.error_message;
}

// ============================================================================
// pm.metrics - custom trends, counters and rates (issue #1500)
// ============================================================================
//
// Bound the same way pm.execution is: refuse loudly with no run behind it
// (a context built by hand, or the deferred replay against a recorded
// sample) rather than silently recording nowhere.

struct MetricsRecordCase {
    std::string_view case_name;
    std::string_view script;
    std::string_view expected_name;
    vayu::core::CustomMetricType expected_type;
    double expected_value;
};

class ScriptEngineMetricsRecordTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<MetricsRecordCase> {};

TEST_P (ScriptEngineMetricsRecordTest, RecordsThroughTheBoundCollector) {
    const auto& param = GetParam ();
    std::vector<std::tuple<std::string, vayu::core::CustomMetricType, double>> recorded;
    auto ctx          = scenario_test (request, response, env);
    ctx.record_metric = [&recorded] (const std::string& name,
                        vayu::core::CustomMetricType type, double value) {
        recorded.emplace_back (name, type, value);
    };

    auto result = engine.execute (std::string (param.script), ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_EQ (std::get<0> (recorded[0]), param.expected_name);
    EXPECT_EQ (std::get<1> (recorded[0]), param.expected_type);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), param.expected_value);
}

// Counter: the increment defaults to one. Rate: the boolean is recorded as
// one or zero.
INSTANTIATE_TEST_SUITE_P (PerMetricMethod,
ScriptEngineMetricsRecordTest,
::testing::Values (MetricsRecordCase{ "Trend", "pm.metrics.trend('ttfb', 42.5);",
                   "ttfb", vayu::core::CustomMetricType::Trend, 42.5 },
MetricsRecordCase{ "Counter", "pm.metrics.counter('hits');", "hits",
vayu::core::CustomMetricType::Counter, 1.0 },
MetricsRecordCase{ "Rate", "pm.metrics.rate('cacheHit', true);", "cacheHit",
vayu::core::CustomMetricType::Rate, 1.0 }),
[] (const ::testing::TestParamInfo<MetricsRecordCase>& info) {
    return std::string (info.param.case_name);
});

// The false-success rule #188 exists for: with no collector bound, the call
// must throw rather than accept a value and drop it on the floor.
TEST_F (ScriptEngineTest, MetricsThrowsWithNoRunToRecordInto) {
    auto result =
    engine.execute_prerequest ("pm.metrics.trend('ttfb', 1);", request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
}

// The deferred `tests` replay's own shape: `for_test` with no `record_metric`
// bound, because a replayed sample is not the run (acceptance criterion 3).
TEST_F (ScriptEngineTest, MetricsThrowsInALoadRunsDeferredTestScript) {
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = engine.execute ("pm.metrics.counter('hits');", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
}

TEST_F (ScriptEngineTest, MetricsTrendRequiresAName) {
    auto ctx = scenario_test (request, response, env);
    ctx.record_metric = [] (const std::string&, vayu::core::CustomMetricType, double) {};
    auto result = engine.execute ("pm.metrics.trend('', 1);", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("empty name"), std::string::npos)
    << result.error_message;
}

// A counter only grows (#1937): a negative or non-finite increment throws and
// records nothing. Mutation check: drop the range check in
// `js_pm_metrics_counter` and every case records and succeeds.
class ScriptEngineMetricsCounterRefusalTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<std::string_view> {};

TEST_P (ScriptEngineMetricsCounterRefusalTest, ThrowsAndRecordsNothing) {
    size_t recorded   = 0;
    auto ctx          = scenario_test (request, response, env);
    ctx.record_metric = [&recorded] (const std::string&,
                        vayu::core::CustomMetricType, double) { ++recorded; };
    auto result       = engine.execute (std::string (GetParam ()), ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("finite increment of 0 or more"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (recorded, 0u);
}

INSTANTIATE_TEST_SUITE_P (NegativeOrNonFinite,
ScriptEngineMetricsCounterRefusalTest,
::testing::Values ("pm.metrics.counter('x', -1);",
"pm.metrics.counter('x', NaN);",
"pm.metrics.counter('x', Infinity);",
"pm.metrics.counter('x', 'not a number');"));

// `increment?` in the declarations: an explicit `undefined` is the default,
// and a zero is a real record (the zero-sum counter a ceiling of 0 watches).
TEST_F (ScriptEngineTest, MetricsCounterTakesUndefinedAsTheDefaultAndRecordsAZero) {
    std::vector<double> recorded;
    auto ctx = scenario_test (request, response, env);
    ctx.record_metric = [&recorded] (const std::string&, vayu::core::CustomMetricType,
                        double value) { recorded.push_back (value); };
    auto result = engine.execute (
    "pm.metrics.counter('x', undefined); pm.metrics.counter('x', 0);", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (recorded.size (), 2u);
    EXPECT_DOUBLE_EQ (recorded[0], 1.0);
    EXPECT_DOUBLE_EQ (recorded[1], 0.0);
}

// The load-mode contract, and it is a decision rather than an omission: a
// deferred `tests` script has already run against a recorded response and
// cannot redirect a sequence that already happened. `validate_scripts` builds
// exactly this `for_test` shape and sets no `in_scenario`.
TEST_F (ScriptEngineTest, SetNextRequestThrowsInALoadRunsDeferredTestScript) {
    auto result = engine.execute_test (
    "pm.execution.setNextRequest('checkout');", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

// Bound rather than absent, so the sentence above is reachable at all: a
// missing binding answers "not a function", which sends someone hunting a
// typo instead of reading why.
TEST_F (ScriptEngineTest, PmExecutionIsBoundEvenWhereItRefusesEveryCall) {
    auto result = engine.execute_test (R"JS(
        pm.test("both methods exist", function() {
            pm.expect(typeof pm.execution.setNextRequest).to.equal("function");
            pm.expect(typeof pm.execution.skipRequest).to.equal("function");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, SetNextRequestRejectsEveryArgumentThatNamesNothing) {
    struct Case {
        const char* script;
        const char* expected;
    };
    // Omitting the argument is not a synonym for null: "end the iteration" and
    // "I forgot the name" are different intents, and guessing between them
    // would silently end runs.
    const auto cases = std::to_array<Case> ({
    { "pm.execution.setNextRequest();", "no argument" },
    { "pm.execution.setNextRequest(3);", "number" },
    { "pm.execution.setNextRequest(undefined);", "undefined" },
    { "pm.execution.setNextRequest('');", "empty name" },
    });

    for (const auto& test_case : cases) {
        auto ctx    = scenario_test (request, response, env);
        auto result = engine.execute (test_case.script, ctx);
        EXPECT_FALSE (result.success) << test_case.script;
        EXPECT_NE (result.error_message.find (test_case.expected), std::string::npos)
        << test_case.script << " reported: " << result.error_message;
        EXPECT_EQ (result.control.kind, ScriptControl::Kind::None) << test_case.script;
    }
}

// Contexts are pooled, so an instruction has to be per-execution state like
// pm.info is. Hold it on the context instead and the next step of the run
// inherits the previous step's jump.
TEST_F (ScriptEngineTest, AnInstructionDoesNotSurviveIntoTheNextExecution) {
    auto first = scenario_test (request, response, env);
    auto first_result =
    engine.execute ("pm.execution.setNextRequest('checkout');", first);
    ASSERT_EQ (first_result.control.kind, ScriptControl::Kind::Next);

    auto second        = scenario_test (request, response, env);
    auto second_result = engine.execute ("1 + 1;", second);
    ASSERT_TRUE (second_result.success) << second_result.error_message;
    EXPECT_EQ (second_result.control.kind, ScriptControl::Kind::None);
    EXPECT_TRUE (second_result.control.target.empty ());
}

// ============================================================================
// pm.iterationData - the data row bound to this iteration (issue #356)
// ============================================================================
//
// The read surface is `get` and `toObject`, the writers refuse, and absence is
// `undefined` rather than an empty scope. That last one is the decision worth
// pinning: unlike pm.execution, this is data, and a script that asks "is this
// run data-driven?" can only get an answer if the binding is missing when
// there is no row.

/// A scenario step's test context, bound to @p row - the shape the runner
/// builds, and the only shape that carries a row at all.
static ScriptContext data_test (const Request& request,
const Response& response,
Environment& env,
const nlohmann::json& row) {
    ScriptContext ctx  = ScriptContext::for_test (request, response);
    ctx.environment    = &env;
    ctx.in_scenario    = true;
    ctx.iteration_data = &row;
    return ctx;
}

TEST_F (ScriptEngineTest, IterationDataGetReadsTheBoundRow) {
    const nlohmann::json row{ { "username", "ada" }, { "attempts", 3 }, { "active", true },
        { "profile", { { "city", "London" } } }, { "nickname", nullptr } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("row reads back", function() {
            pm.expect(pm.iterationData.get("username")).to.equal("ada");
            // Types survive the binding: a CSV column the app typed as a
            // number must not arrive as the string "3".
            pm.expect(pm.iterationData.get("attempts")).to.equal(3);
            pm.expect(pm.iterationData.get("active")).to.equal(true);
            pm.expect(pm.iterationData.get("profile").city).to.equal("London");
            pm.expect(pm.iterationData.get("nickname")).to.equal(null);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The same answer every other pm scope reader gives, so a script that guards
// on a column need not learn a new idiom for this one.
TEST_F (ScriptEngineTest, IterationDataGetOnAnUnknownKeyIsUndefined) {
    const nlohmann::json row{ { "username", "ada" } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("unknown key", function() {
            pm.expect(typeof pm.iterationData.get("missing")).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

/**
 * `pm.variables.replaceIn` resolves the data namespace too (issue #890), and
 * every `pm.variables` reader answers a bound row's bare column names (#1007).
 *
 * replaceIn did not resolve the namespace at first, and that made it the one
 * template resolver in the product that disagreed with the others about what
 * `{{data.column}}` means. A URL, a header and a body all bind it; handing the
 * same string to replaceIn returned it verbatim, so the script had to know
 * which resolver it was talking to. The token came back with its braces on,
 * which reads as "unresolved variable" - the same output an unknown `$name`
 * gives - so nothing said the row was available and simply not consulted.
 *
 * The bare half is #1007's, and it *did* extend `get` / `has` / `toObject`:
 * Postman binds a dataset's columns to bare names, so an imported collection's
 * `pm.variables.get("userId")` means this iteration's row, at the tier Postman
 * puts it - above the environment. The prefixed spelling stays disjoint from
 * the scopes either way: `data.userId` is template syntax, never a variable
 * name, so the readers still answer nothing for it and `pm.iterationData`
 * remains the accessor that reads only the row.
 *
 * Mutation-check: drop the row from the resolver and the first case fails; take
 * the row layer out of `pm.variables` and the last two do; let the scopes
 * answer before the row and the shadowing case does.
 */
TEST_F (ScriptEngineTest, ReplaceInResolvesTheDataNamespaceAgainstTheBoundRow) {
    const nlohmann::json row{ { "userId", "1001" }, { "city", "Portland, OR" },
        { "quantity", 3 }, { "active", true } };
    auto ctx      = data_test (request, response, env, row);
    env["userId"] = { "an-environment-variable", true };
    // A name no column answers, so the fallback half of the rule has something
    // to fall back *to*.
    env["token"] = { "an-environment-token", true };

    auto result = engine.execute (R"JS(
        pm.test("a column resolves", function() {
            pm.expect(pm.variables.replaceIn("user {{data.userId}}")).to.equal("user 1001");
            pm.expect(pm.variables.replaceIn("{{data.city}}")).to.equal("Portland, OR");
        });

        pm.test("a non-string cell substitutes its text", function() {
            // The same rule the request binding uses (`render_data_value`): the
            // template holds text, so the value is spelled the way it would be
            // spelled into a URL - not the typed value pm.iterationData gives.
            pm.expect(pm.variables.replaceIn("{{data.quantity}}")).to.equal("3");
            pm.expect(pm.variables.replaceIn("{{data.active}}")).to.equal("true");
        });

        pm.test("a bound row answers the bare name, above the environment", function() {
            // Postman's precedence, adopted by #1007: while a row is bound, a
            // column shadows a same-named environment variable, which is what
            // makes an imported data-driven collection send this iteration's
            // value instead of a stale one.
            pm.expect(pm.variables.replaceIn("{{userId}}")).to.equal("1001");
            // The reserved spelling still names only the column (#402) - the
            // two rules coexist rather than one replacing the other.
            pm.expect(pm.variables.replaceIn("{{data.userId}}")).to.equal("1001");
            // And a bare name the row does not carry is an ordinary variable,
            // which is what lets one script run with and without a data file.
            pm.expect(pm.variables.replaceIn("{{token}}")).to.equal("an-environment-token");
        });

        pm.test("the bare prefix names nothing", function() {
            // `{{data.}}` is not a column reference, so it falls through to the
            // ordinary unknown-name rule rather than erroring about a column
            // called "" - and that rule leaves the token written as it stands
            // (issue #1009), which is what a script gets back.
            pm.expect(pm.variables.replaceIn("[{{data.}}]")).to.equal("[{{data.}}]");
        });

        pm.test("the scope readers stay out of the namespace", function() {
            // `data.userId` is template syntax, not a variable name: the merged
            // readers answer nothing for it however a row is bound, and
            // `pm.iterationData` is the accessor that reads only the row.
            pm.expect(typeof pm.variables.get("data.userId")).to.equal("undefined");
            pm.expect(pm.variables.has("data.userId")).to.equal(false);
            pm.expect(typeof pm.variables.toObject()["data.userId"]).to.equal("undefined");
            // The row is genuinely bound - otherwise this case would pass for
            // the wrong reason.
            pm.expect(pm.iterationData.get("userId")).to.equal("1001");
        });

        pm.test("the scope readers answer the bare column, typed", function() {
            // The merged reader's top tier (issue #1007), and typed the way
            // pm.iterationData types it: a number column is a number through
            // either accessor, where the template spelling renders text.
            pm.expect(pm.variables.get("userId")).to.equal("1001");
            pm.expect(pm.variables.get("quantity")).to.equal(3);
            pm.expect(pm.variables.has("userId")).to.equal(true);
            pm.expect(pm.variables.toObject()["userId"]).to.equal("1001");
            pm.expect(pm.variables.toObject()["quantity"]).to.equal(3);
            // The fallback, so this is a tier rather than a replacement.
            pm.expect(pm.variables.get("token")).to.equal("an-environment-token");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 6u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

/**
 * A column the row does not carry is an error, the same as it is at bind time.
 *
 * Not "" and not the token verbatim: the token says the value came from the
 * file, so a name the file has no column for is a mistake about the column, and
 * both quiet answers hide it. This is the rule `apply_iteration_template` already
 * enforces on a URL - a script asking the same question gets the same answer.
 */
TEST_F (ScriptEngineTest, ReplaceInThrowsForAColumnTheRowDoesNotCarry) {
    const nlohmann::json row{ { "userId", "1001" } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("names the column and what the row has", function() {
            let message = "nothing thrown";
            try {
                pm.variables.replaceIn("{{data.nosuch}}");
            } catch (e) {
                message = String(e.message || e);
            }
            pm.expect(message).to.include("data.nosuch");
            pm.expect(message).to.include("userId");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

/**
 * With no row bound there is nothing to resolve against, so the token keeps its
 * braces - unchanged from before the fix, and the same thing composition does.
 *
 * Throwing here would be wrong: a plain design send has no row by design, and a
 * shared script that guards with `pm.iterationData` must be able to run in both
 * modes. The token surviving is what a run's plan resolution then refuses by
 * name (issue #415), which is the layer that owns "this needed a data set".
 */
TEST_F (ScriptEngineTest, ReplaceInLeavesADataTokenWrittenWhenNoRowIsBound) {
    ScriptContext ctx = ScriptContext::for_test (request, response);
    ctx.environment   = &env;

    auto result = engine.execute (R"JS(
        pm.test("token survives", function() {
            pm.expect(pm.variables.replaceIn("user {{data.userId}}"))
                .to.equal("user {{data.userId}}");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// `has` exists for parity with every other scope reader in the pm surface
// (pm.environment, pm.globals, pm.collectionVariables, pm.variables, pm.cookies)
// and with Postman, whose pm.iterationData is a VariableScope. The case it is
// the only clean answer to is the null column: the row *has* it, which is a
// different fact from the row not carrying it at all.
TEST_F (ScriptEngineTest, IterationDataHasAnswersPresenceIncludingANullColumn) {
    const nlohmann::json row{ { "username", "ada" }, { "nickname", nullptr } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("presence", function() {
            pm.expect(pm.iterationData.has("username")).to.equal(true);
            pm.expect(pm.iterationData.has("missing")).to.equal(false);
            // Present and null: `has` says the row carries it, and `get`
            // answers null rather than the undefined an absent column gives -
            // so the two agree and neither has to be read as the other.
            pm.expect(pm.iterationData.has("nickname")).to.equal(true);
            pm.expect(pm.iterationData.get("nickname")).to.equal(null);
            pm.expect(typeof pm.iterationData.get("missing")).to.equal("undefined");
            // No argument is no such column, the answer pm.variables.has gives.
            pm.expect(pm.iterationData.has()).to.equal(false);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A reference stashed on the global is gone with the context (#1782), so a later
// script can no more call it than read the row it pointed at.
TEST_F (ScriptEngineTest, AStashedIterationDataDoesNotReachTheNextScript) {
    const nlohmann::json row{ { "username", "ada" } };
    auto first = data_test (request, response, env, row);
    auto first_result =
    engine.execute ("globalThis.stashed = pm.iterationData;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second_result = engine.execute_test (
    "pm.test('stash is gone', function() { pm.expect(typeof "
    "globalThis.stashed).to.equal('undefined'); });",
    request, response, env);

    ASSERT_TRUE (second_result.success) << second_result.error_message;
    ASSERT_EQ (second_result.tests.size (), 1u);
    EXPECT_TRUE (second_result.tests[0].passed) << second_result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, IterationDataToObjectReturnsTheWholeRow) {
    const nlohmann::json row{ { "username", "ada" }, { "attempts", 3 } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("whole row", function() {
            var all = pm.iterationData.toObject();
            pm.expect(Object.keys(all).length).to.equal(2);
            pm.expect(all.username).to.equal("ada");
            pm.expect(all.attempts).to.equal(3);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A write has no destination - the rows are a run input, not a scope - so the
// call throws rather than accepting a value that would vanish at the next
// iteration. Bound and refusing, for the reason pm.execution is.
TEST_F (ScriptEngineTest, IterationDataRefusesEveryWrite) {
    const nlohmann::json row{ { "username", "ada" } };

    for (const char* script : { "pm.iterationData.set('username', 'bob');",
         "pm.iterationData.unset('username');", "pm.iterationData.clear();" }) {
        auto ctx    = data_test (request, response, env, row);
        auto result = engine.execute (script, ctx);

        EXPECT_FALSE (result.success) << script;
        EXPECT_NE (result.error_message.find ("read-only"), std::string::npos)
        << script << " reported: " << result.error_message;
    }

    // And the row itself is untouched by the attempt.
    EXPECT_EQ (row.at ("username"), "ada");
}

// The #300 boundary, unchanged: a single send has no iteration and therefore
// no row. `undefined` and not an empty scope - a script may branch on it.
TEST_F (ScriptEngineTest, IterationDataIsUndefinedInASingleSend) {
    auto result = engine.execute_prerequest (R"JS(
        pm.test("no data", function() {
            pm.expect(typeof pm.iterationData).to.equal("undefined");
        });
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The load-mode contract: `validate_scripts` builds exactly this `for_test`
// shape and binds no row, because a deferred script runs after the run against
// a sampled response and there is no iteration it belongs to.
TEST_F (ScriptEngineTest, IterationDataIsUndefinedInALoadRunsDeferredTestScript) {
    auto result = engine.execute_test (R"JS(
        pm.test("no data", function() {
            pm.expect(typeof pm.iterationData).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Contexts are pooled and the global object survives with them, so the binding
// has to be rebuilt per execution the way pm.info is. Leave the previous
// step's object standing and a single send reads the last collection run's
// data - a row from a run that has finished, reported as this request's.
TEST_F (ScriptEngineTest, ARowDoesNotSurviveIntoTheNextExecution) {
    const nlohmann::json row{ { "username", "ada" } };
    auto first = data_test (request, response, env, row);
    auto first_result = engine.execute ("pm.iterationData.get('username');", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second_result = engine.execute_test (R"JS(
        pm.test("no data", function() {
            pm.expect(typeof pm.iterationData).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (second_result.success) << second_result.error_message;
    ASSERT_EQ (second_result.tests.size (), 1u);
    EXPECT_TRUE (second_result.tests[0].passed) << second_result.tests[0].error_message;
}

// ============================================================================
// pm.response.events - a streamed run's buffered event list (issue #575)
// ============================================================================
//
// The three properties are one fact about one arrival set, and the decision
// worth pinning is the same one `pm.iterationData` makes: absence is *absent*.
// A script asking "was this a stream?" can only get an answer if the binding is
// missing when it was not one, and a script asserting over the whole stream can
// only be right if the markers say when it is looking at a prefix.

/// A streamed run's test context: the stored `events` trace node the route
/// hands the post-request script, verbatim.
static ScriptContext streamed_test (const Request& request,
const Response& response,
Environment& env,
const nlohmann::json& events) {
    ScriptContext ctx   = ScriptContext::for_test (request, response);
    ctx.environment     = &env;
    ctx.response_events = &events;
    return ctx;
}

TEST_F (ScriptEngineTest, ResponseEventsCarriesEachEntrysNameIdAndData) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "tick" }, { "data", "{\"n\":1}" },
                                 { "sourceId", "e1" }, { "receivedAt", 17 } },
        nlohmann::json{ { "event", "message" }, { "data", "plain" }, { "receivedAt", 18 } } }) },
        { "totalEvents", 2 }, { "eventsTruncated", false }, { "endReason", "completed" }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("entries read back", function() {
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.events[0].event).to.equal("tick");
            pm.expect(pm.response.events[0].id).to.equal("e1");
            pm.expect(JSON.parse(pm.response.events[0].data).n).to.equal(1);
            pm.expect(pm.response.events[1].event).to.equal("message");
            pm.expect(pm.response.events[1].data).to.equal("plain");
        });
        pm.test("an event the origin never named has no id at all", function() {
            pm.expect(typeof pm.response.events[1].id).to.equal("undefined");
        });
        pm.test("each entry carries the time the engine stamped it", function() {
            pm.expect(pm.response.events[0].receivedAt).to.equal(17);
            pm.expect(pm.response.events[1].receivedAt).to.equal(18);
            pm.expect(typeof pm.response.events[0].receivedAt).to.equal("number");
        });
        pm.test("the markers mirror the node", function() {
            pm.expect(pm.response.totalEvents).to.equal(2);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 4u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// A load run's sampled node is built without a clock reading, and a script
// reading a time that was never measured would compare against nothing. Absent,
// not 0 or null: `'receivedAt' in event` is how a script tells the two apart.
TEST_F (ScriptEngineTest, ResponseEventsOmitsReceivedAtWhenTheNodeHasNone) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "tick" }, { "data", "1" } },
        nlohmann::json{ { "event", "tick" }, { "data", "2" }, { "receivedAt", "soon" } } }) },
        { "totalEvents", 2 }, { "eventsTruncated", false }, { "endReason", "completed" }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("an unmeasured arrival time is absent", function() {
            pm.expect(typeof pm.response.events[0].receivedAt).to.equal("undefined");
            pm.expect("receivedAt" in pm.response.events[0]).to.equal(false);
        });
        pm.test("a stored value that is not a time is not passed through", function() {
            pm.expect("receivedAt" in pm.response.events[1]).to.equal(false);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 2u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// The whole point of the markers: a stored list shorter than the stream must
// never read as the stream. Truncation is the node's own comparison, not
// `items.length` against a cap the script cannot see.
TEST_F (ScriptEngineTest, ResponseEventsReportsATruncatedListAsOne) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "tick" }, { "data", "1" } } }) },
        { "totalEvents", 40 }, { "eventsTruncated", true }, { "endReason", "maxEvents" }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("a prefix says it is one", function() {
            pm.expect(pm.response.events.length).to.equal(1);
            pm.expect(pm.response.totalEvents).to.equal(40);
            pm.expect(pm.response.eventsTruncated).to.equal(true);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// An event whose data hit the per-event byte cap is a prefix of what the origin
// sent, and says so in band - the same disclosure the stored node makes.
TEST_F (ScriptEngineTest, ResponseEventsDisclosesAPerEventTruncation) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "big" }, { "data", "abc" },
                                 { "dataTruncated", true }, { "dataBytes", 9000 } },
        nlohmann::json{ { "event", "small" }, { "data", "ok" } } }) },
        { "totalEvents", 2 }, { "eventsTruncated", false }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("a cut event is flagged and a whole one is not", function() {
            pm.expect(pm.response.events[0].dataTruncated).to.equal(true);
            pm.expect(typeof pm.response.events[1].dataTruncated).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The engine's error mark (#3996) reaches a script as `isError`, absent on an
// event it did not mark. Mutation check: drop the `isError` copy in
// `install_response_events` and the first expectation fails.
TEST_F (ScriptEngineTest, ResponseEventsCarriesTheErrorMark) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "message" }, { "data", "token" } },
        nlohmann::json{ { "event", "message" },
        { "data", R"({"error":{"message":"overloaded"}})" }, { "isError", true } } }) },
        { "totalEvents", 2 }, { "eventsTruncated", false }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("the error chunk is marked and the token is not", function() {
            pm.expect(pm.response.events[1].isError).to.equal(true);
            pm.expect(typeof pm.response.events[0].isError).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A stream that declared a `streamTextPath` (#3773) binds each event's `text`
// and the joined `streamText`; one that declared none binds neither, so
// `typeof` tells "no path" from "a path that read nothing" (""). Mutation
// check: drop the `streamText` binding in `install_response_events` and the
// first test fails.
TEST_F (ScriptEngineTest, ResponseEventsBindsTheDeclaredStreamText) {
    const nlohmann::json with_path{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "message" },
                                 { "data", "{\"t\":\"Hel\"}" }, { "text", "Hel" } },
        nlohmann::json{ { "event", "ping" }, { "data", "{}" } } }) },
        { "totalEvents", 3 }, { "eventsTruncated", true }, { "streamText", "Hello" }
    };
    auto ctx    = streamed_test (request, response, env, with_path);
    auto result = engine.execute (R"JS(
        pm.test("the joined text and each part", function() {
            pm.expect(pm.response.streamText).to.equal("Hello");
            pm.expect(pm.response.events[0].text).to.equal("Hel");
            pm.expect(typeof pm.response.events[1].text).to.equal("undefined");
        });
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;

    const nlohmann::json without_path{ { "items",
                                       nlohmann::json::array ({ nlohmann::json{
                                       { "event", "message" }, { "data", "x" } } }) },
        { "totalEvents", 1 }, { "eventsTruncated", false } };
    auto bare_ctx    = streamed_test (request, response, env, without_path);
    auto bare_result = engine.execute (R"JS(
        pm.test("no path, no text", function() {
            pm.expect(typeof pm.response.streamText).to.equal("undefined");
            pm.expect(typeof pm.response.events[0].text).to.equal("undefined");
        });
    )JS",
    bare_ctx);
    ASSERT_TRUE (bare_result.success) << bare_result.error_message;
    ASSERT_EQ (bare_result.tests.size (), 1u);
    EXPECT_TRUE (bare_result.tests[0].passed) << bare_result.tests[0].error_message;
}

// Absent, not empty. An ordinary send binds none of the three, so `typeof`
// separates "this was not a stream" from "this stream produced nothing" - the
// distinction an empty array would erase.
TEST_F (ScriptEngineTest, AnOrdinaryResponseBindsNoEventSurface) {
    auto result = engine.execute_test (R"JS(
        pm.test("no event surface", function() {
            pm.expect(typeof pm.response.events).to.equal("undefined");
            pm.expect(typeof pm.response.totalEvents).to.equal("undefined");
            pm.expect(typeof pm.response.eventsTruncated).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A stream that produced nothing is the other side of that: the surface is
// there and empty, which is what lets a script tell the two apart.
TEST_F (ScriptEngineTest, AStreamThatProducedNothingBindsAnEmptyList) {
    const nlohmann::json events{ { "items", nlohmann::json::array () },
        { "totalEvents", 0 }, { "eventsTruncated", false }, { "endReason", "idle" } };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("empty but present", function() {
            pm.expect(typeof pm.response.events).to.equal("object");
            pm.expect(pm.response.events.length).to.equal(0);
            pm.expect(pm.response.totalEvents).to.equal(0);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Contexts are pooled, so the object a script stashed survives into the next
// execution. A non-streaming run after a streamed one must not still be
// carrying the stream's list - the leak `pm.iterationData` had.
TEST_F (ScriptEngineTest, ThePooledContextDoesNotCarryEventsIntoTheNextRun) {
    const nlohmann::json events{ { "items",
                                 nlohmann::json::array ({ nlohmann::json{
                                 { "event", "tick" }, { "data", "1" } } }) },
        { "totalEvents", 1 }, { "eventsTruncated", false } };
    auto first        = streamed_test (request, response, env, events);
    auto first_result = engine.execute ("pm.response.events.length;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second_result = engine.execute_test (R"JS(
        pm.test("the next run is not a stream", function() {
            pm.expect(typeof pm.response.events).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (second_result.success) << second_result.error_message;
    ASSERT_EQ (second_result.tests.size (), 1u);
    EXPECT_TRUE (second_result.tests[0].passed) << second_result.tests[0].error_message;
}
