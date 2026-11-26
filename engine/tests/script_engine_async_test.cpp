/**
 * @file script_engine_async_test.cpp
 * @brief Promises, timers and top-level await.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <string>

#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

// ============================================================================
// Promises: the job queue is drained, and a rejection is a script error (#2531)
// ============================================================================

// postman-sandbox records an async callback's test as passed without awaiting
// it and reports the rejection as a script error; the row stays passed so the
// result reads as Postman's would.
TEST_F (ScriptEngineTest, AnAsyncTestThatRejectsReportsAScriptError) {
    auto result = engine.execute_test (R"JS(
        pm.test("t", async () => { pm.expect(1).to.eql(2); });
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (R"(Unhandled promise rejection in test "t": )"),
    std::string::npos)
    << result.error_message;
    EXPECT_NE (result.error_message.find ("deeply equal 2"), std::string::npos)
    << result.error_message;
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The assertion after the `await` only runs because the queue is drained.
TEST_F (ScriptEngineTest, AnAsyncTestThatAwaitsThenFailsIsReported) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        pm.test("after await", async () => {
            const code = await Promise.resolve(pm.response.code);
            pm.environment.set("resumed", "1");
            pm.expect(code).to.equal(500);
        });
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (R"(Unhandled promise rejection in test "after await": )"),
    std::string::npos)
    << result.error_message;
    EXPECT_NE (result.error_message.find ("equal 500"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (env["resumed"].value, "1");
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, AnUnobservedRejectionOutsideATestIsReported) {
    auto result = engine.execute_test (R"JS(
        (async () => { throw new Error("x"); })();
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Unhandled promise rejection: Error: x");
}

// Each rejection the script never observed counts; the first is the one named.
TEST_F (ScriptEngineTest, EveryUnobservedRejectionIsCounted) {
    auto result = engine.execute_test (R"JS(
        Promise.reject(new Error("first"));
        Promise.reject(new Error("second"));
        Promise.reject(new Error("third"));
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Unhandled promise rejection: Error: first (and 2 more unhandled rejections)");
}

// The guard against reporting every rejection: one the script handles, before
// or after it settles, is not an error.
TEST_F (ScriptEngineTest, AHandledRejectionIsNotAnError) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        Promise.reject(new Error("caught")).catch(() => {});
        const later = Promise.reject(new Error("handled later"));
        (async () => {
            await null;
            later.catch(() => {});
            try {
                await Promise.reject(new Error("awaited"));
            } catch (e) {
                pm.environment.set("caught", e.message);
            }
        })();
        pm.test("handles its own", async () => {
            try { await Promise.reject(new Error("inner")); } catch (e) {}
        });
    )JS",
    ctx);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["caught"].value, "awaited");
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, APassingAsyncTestStaysGreen) {
    auto result = engine.execute_test (R"JS(
        pm.test("green", async () => {
            const code = await Promise.resolve(pm.response.code);
            pm.expect(code).to.equal(200);
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

// Nothing in this sandbox can settle a promise once the script has ended, so a
// test whose promise is still pending after the drain never finished.
TEST_F (ScriptEngineTest, AnAsyncTestThatNeverSettlesIsReported) {
    auto result = engine.execute_test (R"JS(
        pm.test("stuck", async () => { await new Promise(() => {}); });
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    R"(A promise did not settle before the script ended (returned by test "stuck"))");
}

TEST_F (ScriptEngineTest, PendingJobsRunWithinTheDeadline) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    const auto start = std::chrono::steady_clock::now ();
    auto result =
    bounded.execute ("(async () => { for (;;) { await null; } })();", ctx);
    const auto elapsed = std::chrono::steady_clock::now () - start;

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
    EXPECT_LT (elapsed, std::chrono::seconds (5));
}

// The interrupt handler polls only every few thousand bytecode operations, so a
// job short enough would slip in after the deadline stopped the script; the
// drain checks the clock before each job so that none does.
TEST_F (ScriptEngineTest, AScriptTheDeadlineStoppedRunsNoneOfItsJobs) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;

    auto result = bounded.execute (R"JS(
        Promise.resolve().then(() => pm.environment.set("late", "1"));
        for (;;) {}
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
    EXPECT_EQ (env.count ("late"), 0U);
}

// A job that itself runs past the deadline is stopped by the interrupt handler,
// and reported as the same timeout.
TEST_F (ScriptEngineTest, AJobThatSpinsIsStoppedByTheDeadline) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    auto result =
    bounded.execute ("(async () => { await null; for (;;) {} })();", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
}

// With no deadline the job cap bounds the drain, with its own message.
TEST_F (ScriptEngineTest, WithNoTimeoutTheJobCapStopsARunawayDrain) {
    ScriptConfig cfg;
    cfg.timeout_ms = 0;
    ScriptEngine unbounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    auto result =
    unbounded.execute ("(async () => { for (;;) { await null; } })();", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (
               "Script stopped after running 100000 promise jobs"),
    std::string::npos)
    << result.error_message;
    EXPECT_EQ (unbounded.idle_runtime_count (), 0U);
}

// A script's own throw is the error it reports, and a job it queued before
// throwing still runs, as it would on Postman's event loop.
TEST_F (ScriptEngineTest, AThrowStaysTheErrorAndItsQueuedJobsStillRun) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        Promise.resolve().then(() => pm.environment.set("ran", "1"));
        Promise.reject(new Error("also unhandled"));
        throw new Error("the script's own");
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: the script's own");
    EXPECT_EQ (env["ran"].value, "1");
}

// ============================================================================
// Timers: run to completion before the script ends (#2577)
// ============================================================================

// Due order, ties to the first queued, a missing delay as Node's 1ms, and the
// promise jobs a callback queues before the next timer. The last timer is due
// a minute in, under the default five-second deadline: a queue that slept
// would time out instead of reporting the order.
TEST_F (ScriptEngineTest, TimersFireInDueOrderBeforeTheScriptEnds) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const order = [];
        setTimeout(() => order.push("b"), 20);
        setTimeout(() => {
            order.push("a");
            Promise.resolve().then(() => order.push("a-job"));
        }, 10);
        setTimeout((x, y) => order.push(x + y), 20, "c", "d");
        setTimeout(() => order.push("no delay"));
        Promise.resolve().then(() => order.push("job"));
        setTimeout(() => pm.environment.set("order", order.join(",")), 60000);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["order"].value, "job,no delay,a,a-job,b,cd");
}

TEST_F (ScriptEngineTest, ClearTimeoutCancelsATimer) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const cancelled = setTimeout(() => pm.environment.set("cancelled", "1"), 10);
        clearTimeout(cancelled);
        const later = setTimeout(() => pm.environment.set("later", "1"), 20);
        setTimeout(() => clearTimeout(later), 10);
        clearTimeout(123456);
        clearTimeout();
        clearTimeout("not an id");
        setTimeout(() => pm.environment.set("kept", "1"), 30);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("cancelled"), 0U);
    EXPECT_EQ (env.count ("later"), 0U);
    EXPECT_EQ (env["kept"].value, "1");
}

// The interval ticks at 10, 20 and 30 on the virtual clock, so the timeout due
// at 25 lands between the second and third tick; clearing it from its own
// callback stops it.
TEST_F (ScriptEngineTest, SetIntervalRepeatsUntilClearIntervalStopsIt) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const order = [];
        let ticks = 0;
        const interval = setInterval((tag) => {
            ticks++;
            order.push(tag + ticks);
            if (ticks === 3) clearInterval(interval);
        }, 10, "tick");
        setTimeout(() => order.push("t25"), 25);
        setTimeout(() => pm.environment.set("order", order.join(",")), 1000);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["order"].value, "tick1,tick2,t25,tick3");
}

TEST_F (ScriptEngineTest, ATimerCanRecordATest) {
    auto result = engine.execute_test (R"JS(
        setTimeout(() => {
            pm.test("from a timer", () => pm.expect(pm.response.code).to.equal(200));
        }, 10);
        setTimeout(() => {
            pm.test("fails from a timer", () => pm.expect(pm.response.code).to.equal(500));
        }, 20);
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 2U);
    EXPECT_EQ (result.tests[0].name, "from a timer");
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (result.tests[1].name, "fails from a timer");
    EXPECT_FALSE (result.tests[1].passed);
}

// A promise only a timer settles is settled by the drain, rather than reported
// as one that never settled.
TEST_F (ScriptEngineTest, AnAwaitedTimerSettlesItsPromise) {
    auto result = engine.execute_test (R"JS(
        pm.test("waits on a timer", async () => {
            const value = await new Promise((resolve) => setTimeout(resolve, 5, 42));
            pm.expect(value).to.equal(42);
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

// A callback's throw is the script's error, and the queue drains on, as a throw
// in the script body already does.
TEST_F (ScriptEngineTest, ATimerThatThrowsIsTheErrorAndTheQueueDrainsOn) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        setTimeout(() => { throw new Error("from the timer"); }, 10);
        setTimeout(() => pm.environment.set("after", "1"), 20);
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: from the timer");
    EXPECT_EQ (env["after"].value, "1");
}

TEST_F (ScriptEngineTest, ATimerNeedsAFunction) {
    auto result = engine.execute_test (
    "setTimeout('pm.test(\"x\", () => {})', 0);", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    "TypeError: setTimeout requires a function as its first argument");
    EXPECT_TRUE (result.tests.empty ());
}

// The queue lives outside the QuickJS heap, so its own cap is what bounds it.
TEST_F (ScriptEngineTest, PendingTimersAreCapped) {
    auto result = engine.execute_test (R"JS(
        for (let i = 0; i <= 10000; i++) setTimeout(() => {}, 1);
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    "RangeError: setTimeout: 10000 timers are already pending, the most one "
    "script may hold");
}

// An interval nothing clears is stopped by the deadline, or by the cap with no
// deadline, and reported. Its queue is freed with the execution, so the
// runtime goes back to the pool; a promise job left behind would discard it.
TEST_F (ScriptEngineTest, ARunawayIntervalStopsWithAScriptError) {
    ScriptConfig bounded_cfg;
    bounded_cfg.timeout_ms = 100;
    ScriptEngine bounded (bounded_cfg);
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = bounded.execute ("setInterval(() => {}, 0);", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
    EXPECT_EQ (bounded.idle_runtime_count (), 1U);

    ScriptConfig unbounded_cfg;
    unbounded_cfg.timeout_ms = 0;
    ScriptEngine unbounded (unbounded_cfg);
    result = unbounded.execute ("setInterval(() => {}, 0);", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("Script stopped after running 100000 "
                                          "promise jobs and timer callbacks"),
    std::string::npos)
    << result.error_message;
    EXPECT_EQ (unbounded.idle_runtime_count (), 1U);
}

// A timer still queued when the deadline stops the script never runs, in this
// execution or the next one on the same pooled runtime.
TEST_F (ScriptEngineTest, ATimerLeftAtTheDeadlineNeverRuns) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);

    auto first        = ScriptContext::for_test (request, response);
    first.environment = &env;
    auto first_result = bounded.execute (R"JS(
        setTimeout(() => pm.environment.set("late", "1"), 10);
        for (;;) {}
    )JS",
    first);
    EXPECT_FALSE (first_result.success);
    EXPECT_EQ (first_result.error_message, "Script execution timed out after 100ms");
    EXPECT_EQ (bounded.idle_runtime_count (), 1U);

    auto second        = ScriptContext::for_test (request, response);
    second.environment = &env;
    auto second_result = bounded.execute ("pm.environment.set('next', '1');", second);
    ASSERT_TRUE (second_result.success) << second_result.error_message;

    EXPECT_EQ (env.count ("late"), 0U);
    EXPECT_EQ (env.count ("next"), 1U);
}

// A queued timer pins its context as a promise job does (#1823), so a queue
// left at the deadline and never freed would keep every dead context, each
// holding the half of the memory limit its callback reads; the next script's
// own allocation then fails. The 5ms deadline only leaves the timer queued.
TEST_F (ScriptEngineTest, TimersLeftAtTheDeadlineDoNotExhaustThePooledRuntime) {
    ScriptConfig cfg;
    cfg.memory_limit = size_t{ 8 } * 1024 * 1024;
    cfg.timeout_ms   = 5;
    ScriptEngine pooled (cfg);

    constexpr int executions = 50;
    for (int i = 0; i < executions; ++i) {
        auto ctx    = ScriptContext::for_test (request, response);
        auto result = pooled.execute (R"JS(
            const headroom = new ArrayBuffer(4 * 1024 * 1024);
            setTimeout(() => headroom.byteLength, 10);
            for (;;) {}
        )JS",
        ctx);
        ASSERT_EQ (result.error_message, "Script execution timed out after 5ms")
        << "execution " << i;
    }
    EXPECT_EQ (pooled.idle_runtime_count (), 1U);
}

// ============================================================================
// Top-level await: the script body is an async function (#2577)
// ============================================================================

TEST_F (ScriptEngineTest, ATopLevelAwaitOfAResolvedPromiseRuns) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const value = await Promise.resolve(41);
        pm.environment.set("value", String(value + 1));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["value"].value, "42");
}

TEST_F (ScriptEngineTest, ATestAfterATopLevelAwaitIsRecorded) {
    auto result = engine.execute_test (R"JS(
        const code = await Promise.resolve(pm.response.code);
        pm.test("passes after await", () => pm.expect(code).to.equal(200));
        pm.test("fails after await", () => pm.expect(code).to.equal(500));
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_TRUE (result.error_message.empty ()) << result.error_message;
    ASSERT_EQ (result.tests.size (), 2U);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
}

// The body resumes when the timer it awaits fires, between the timers due
// before and after it on the virtual clock.
TEST_F (ScriptEngineTest, ATopLevelAwaitOfATimerResumesWhenItFires) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const order = [];
        setTimeout(() => order.push("t10"), 10);
        setTimeout(() => order.push("t30"), 30);
        order.push(await new Promise((resolve) => setTimeout(resolve, 20, "t20")));
        setTimeout(() => order.push("t25"), 5);
        await new Promise((resolve) => setTimeout(resolve, 60000));
        pm.environment.set("order", order.join(","));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["order"].value, "t10,t20,t25,t30");
}

// A throw after an `await` is the script's own error, reported as the throw
// itself rather than as the wrapper's unhandled rejection.
TEST_F (ScriptEngineTest, AThrowAfterATopLevelAwaitIsTheScriptsError) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        setTimeout(() => pm.environment.set("drained", "1"), 10);
        await null;
        throw new Error("after await");
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: after await");
    EXPECT_EQ (env["drained"].value, "1");

    result = engine.execute_test (
    "await Promise.reject(new Error('awaited rejection'));", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: awaited rejection");
}

// The first error is the one reported, by when it happened: the body's throw
// and a timer callback's are ordered on the virtual clock.
TEST_F (ScriptEngineTest, ABodyThrowAndATimerThrowAreReportedInTheOrderTheyHappened) {
    auto timer_first = engine.execute_test (R"JS(
        setTimeout(() => { throw new Error("timer at 10"); }, 10);
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("body at 20");
    )JS",
    request, response, env);
    EXPECT_EQ (timer_first.error_message, "Error: timer at 10");

    auto body_first = engine.execute_test (R"JS(
        setTimeout(() => { throw new Error("timer at 20"); }, 20);
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("body at 10");
    )JS",
    request, response, env);
    EXPECT_EQ (body_first.error_message, "Error: body at 10");
}

TEST_F (ScriptEngineTest, ATopLevelReturnStillEndsTheScript) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        pm.environment.set("before", "1");
        if (pm.response.code === 200) return;
        pm.environment.set("after", "1");
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["before"].value, "1");
    EXPECT_EQ (env.count ("after"), 0U);

    result = engine.execute (R"JS(
        await null;
        return;
        pm.environment.set("after await", "1");
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("after await"), 0U);
}

// The wrapper's promise rejects on a synchronous throw too; the message stays
// the throw's own, with no "Unhandled promise rejection" in front of it.
TEST_F (ScriptEngineTest, ASynchronousThrowKeepsItsOwnMessage) {
    auto result =
    engine.execute_test ("throw new Error('sync');", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: sync");

    result = engine.execute_test ("throw 'a plain string';", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "a plain string");
}

// The wrapper adds no line, so a stack names the script's own line.
TEST_F (ScriptEngineTest, AStackNamesTheScriptsOwnLine) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result =
    engine.execute ("// line 1\n"
                    "await null;\n"
                    "pm.environment.set('stack', new Error('x').stack);",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_NE (env["stack"].value.find ("<script>:3:"), std::string::npos)
    << env["stack"].value;
}

// Nothing can settle a promise once the queues are empty, so a body still
// awaiting one never ran its remaining lines, and says so.
TEST_F (ScriptEngineTest, ABodyAwaitingAPromiseThatNeverSettlesIsReported) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        await new Promise(() => {});
        pm.environment.set("after", "1");
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    "The script did not finish: it was still awaiting a promise that never "
    "settled");
    EXPECT_EQ (env.count ("after"), 0U);
}

// What a context that declares neither reports (#353): a bare `for_test` shape,
// which is what an ordinary `POST /execute` send - one carrying no `data` row -
// reaches the engine with. Both read undefined, and that is #300's ruling
// intact: an invented index would be a binding that cannot fail.
//
// More than the scenario runner reports the pair, and this test does not say
// otherwise. A load run's deferred `validate_scripts` sets `iteration` and
// `vu` from the sample the response was actually sent in (#994,
// `run_manager.cpp`), and a send that bound a row reports iteration 0 of 1
// (#601). `iterationCount` is the one that stays absent under load - a
// duration-bounded run has no total.
TEST_F (ScriptEngineTest, PmInfoOmitsTheIterationPairOutsideAScenarioRun) {
    auto result = engine.execute_test (R"JS(
        pm.test("no iteration", function() {
            pm.expect(typeof pm.info.iteration).to.equal("undefined");
            pm.expect(typeof pm.info.iterationCount).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The other half: a runner-set context reports real numbers, including
// iteration 0 - which must read as 0, not as absent, or every first iteration
// would look like a run that declared none.
TEST_F (ScriptEngineTest, PmInfoReportsTheIterationPairWhenTheRunnerSetsIt) {
    auto ctx            = ScriptContext::for_test (request, response);
    ctx.environment     = &env;
    ctx.iteration       = 0;
    ctx.iteration_count = 5;

    auto result = engine.execute (R"JS(
        pm.test("iteration is bound", function() {
            pm.expect(pm.info.iteration).to.equal(0);
            pm.expect(pm.info.iterationCount).to.equal(5);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Pooled contexts again: a step that ran with an iteration must not leave one
// behind for the next caller that declared none.
TEST_F (ScriptEngineTest, TheIterationPairDoesNotSurviveIntoTheNextExecution) {
    auto first            = ScriptContext::for_test (request, response);
    first.iteration       = 2;
    first.iteration_count = 3;
    auto first_result     = engine.execute ("pm.info.iteration;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (R"JS(
        pm.test("no leak", function() {
            pm.expect(typeof pm.info.iteration).to.equal("undefined");
            pm.expect(typeof pm.info.iterationCount).to.equal("undefined");
        });
    )JS",
    second);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}
