/**
 * @file script_engine_test.cpp
 * @brief The core of the QuickJS scripting engine: basics, console, script parts, error
 *        handling, pre-request scripts, timeouts, the sandbox's global surface and
 *        what a script error reads as.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <latch>
#include <regex>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "script_engine_fixture.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/encoding.hpp"

using namespace vayu;
using namespace vayu::runtime;

using vayu::tests::console_limit_markers;
using vayu::tests::is_console_limit_marker;

// ============================================================================
// Basic Engine Tests
// ============================================================================

TEST_F (ScriptEngineTest, IsAvailable) {
#ifdef VAYU_HAS_QUICKJS
    EXPECT_TRUE (ScriptEngine::is_available ());
    EXPECT_FALSE (ScriptEngine::version ().empty ());
#else
    EXPECT_FALSE (ScriptEngine::is_available ());
    EXPECT_TRUE (ScriptEngine::version ().empty ());
#endif
}

#ifdef VAYU_HAS_QUICKJS
// version() reported a hardcoded "QuickJS 2024-01-13" while the tree carried
// quickjs-ng 0.16.0 (issue #112), and the assertion above - non-empty - could
// not tell the difference. Pin it to what the vendored runtime reports instead,
// so the string tracks a vendor bump rather than needing to be remembered.
TEST_F (ScriptEngineTest, VersionReportsTheVendoredRuntime) {
    const std::string reported = ScriptEngine::version ();

    // A version, not a release date. Deliberately not pinned to the current
    // 0.16.0: the point is that the string comes from the vendored runtime, so
    // a vendor bump should keep this green while a hardcoded literal cannot.
    EXPECT_TRUE (std::regex_search (reported, std::regex (R"(QuickJS-ng \d+\.\d+\.\d+)")))
    << "version() must report the vendored quickjs-ng version, got: " << reported;
    EXPECT_EQ (reported.find ("2024-01-13"), std::string::npos)
    << "version() is carrying a hardcoded date again: " << reported;
}
#endif

TEST_F (ScriptEngineTest, ExecuteEmptyScript) {
    ScriptContext ctx;
    ctx.response = &response;

    auto result = engine.execute ("", ctx);
    EXPECT_TRUE (result.success);
    EXPECT_TRUE (result.tests.empty ());
}

TEST_F (ScriptEngineTest, ExecuteSimpleExpression) {
    ScriptContext ctx;
    auto result = engine.execute ("1 + 1", ctx);
    EXPECT_TRUE (result.success);
}

// quickjs-ng before 0.18.0 freed a WeakMap's records while walking them, so a
// map whose values were symbols it also held as keys was a use-after-free in
// the finalizer: a crash of the whole engine from plain script code, reached
// when the function's locals die and again when the runtime is torn down
// (upstream issue #1835, whose reproducer this is). The last map stays alive
// until the execution's runtime is freed, which is the second path.
TEST_F (ScriptEngineTest, AWeakMapHoldingItsOwnSymbolKeysIsFreedSafely) {
    ScriptContext ctx;
    const auto result = engine.execute (R"(
        function chained() {
            var o = {}, m = new WeakMap(), b = Symbol("b");
            m.set(o, b);
            m.set(b, 1);
            b = undefined;
            m = undefined;
        }
        function longer() {
            var o = {}, m = new WeakMap();
            var a = Symbol("a"), b = Symbol("b"), c = Symbol("c");
            m.set(o, a);
            m.set(a, b);
            m.set(b, c);
            m.set(c, 1);
            a = b = c = undefined;
            m = undefined;
        }
        chained();
        longer();
        const kept = new WeakMap(), x = Symbol("x"), y = Symbol("y");
        kept.set(x, y);
        kept.set(y, x);
        if (kept.get(x) !== y || kept.get(y) !== x) throw new Error("lookup");
    )",
    ctx);
    EXPECT_TRUE (result.success) << result.error_message;
}

// ============================================================================
// Console Output Tests
// ============================================================================

TEST_F (ScriptEngineTest, ConsoleLog) {
    auto result = engine.execute_test (R"(
        console.log("Hello, World!");
        console.log("Value:", 42);
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_GE (result.console_output.size (), 2);
    EXPECT_EQ (result.console_output[0].message, "Hello, World!");
    EXPECT_EQ (result.console_output[1].message, "Value: 42");
}

// The four methods were bound to one C function that recorded no level, so
// every line reached the app looking identical whether the script called
// `log` or `error` - the Console tab had nothing to differentiate on.
TEST_F (ScriptEngineTest, ConsoleRecordsTheLevelItWasCalledWith) {
    auto result = engine.execute_test (R"(
        console.log("plain");
        console.info("noted");
        console.warn("careful");
        console.error("broken");
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.console_output.size (), 4u);
    EXPECT_EQ (result.console_output[0].level, vayu::ConsoleLevel::Log);
    EXPECT_EQ (result.console_output[1].level, vayu::ConsoleLevel::Info);
    EXPECT_EQ (result.console_output[2].level, vayu::ConsoleLevel::Warn);
    EXPECT_EQ (result.console_output[3].level, vayu::ConsoleLevel::Error);

    // The message must survive the level being carried beside it.
    EXPECT_EQ (result.console_output[3].message, "broken");
}

// `scriptEnableConsole: false` is the recommended load-test setting, and it
// used to leave `console` undefined, so the first `console.log` threw a
// ReferenceError and every later `pm.test` of the script never ran (#3461).
// The console stays defined and its four methods record nothing.
class ScriptEngineConsoleOffTest : public ScriptEngineTest {
    protected:
    static ScriptConfig console_off_config () {
        ScriptConfig cfg;
        cfg.enable_console = false;
        return cfg;
    }
};

TEST_F (ScriptEngineConsoleOffTest, LoggingScriptKeepsRunningItsTests) {
    ScriptEngine quiet (console_off_config ());
    auto ctx = ScriptContext::for_test (request, response);
    auto result = quiet.execute ("console.log('x'); pm.test('t', () => {});", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.console_output.empty ());
}

TEST_F (ScriptEngineConsoleOffTest, AllFourMethodsAreCallableAndRecordNothing) {
    ScriptEngine quiet (console_off_config ());
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = quiet.execute (R"JS(
        console.log('a', { nested: [1, 2] });
        console.info('b');
        console.warn('c');
        console.error('d');
        pm.test('methods are functions', () => {
            for (const name of ['log', 'info', 'warn', 'error']) {
                pm.expect(typeof console[name]).to.equal('function');
            }
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.console_output.empty ());
}

// A rebuilt pooled context goes through the same `build_context`, so the
// second execution on one engine proves the no-op console survives the reuse.
TEST_F (ScriptEngineConsoleOffTest, PooledContextReuseKeepsTheNoOpConsole) {
    ScriptEngine quiet (console_off_config ());
    for (int run = 0; run < 2; ++run) {
        auto ctx = ScriptContext::for_test (request, response);
        auto result =
        quiet.execute ("console.warn('again'); pm.test('t', () => {});", ctx);

        ASSERT_TRUE (result.success) << "execution " << run << ": " << result.error_message;
        ASSERT_EQ (result.tests.size (), 1u) << "execution " << run;
        EXPECT_TRUE (result.console_output.empty ()) << "execution " << run;
    }
    EXPECT_EQ (quiet.idle_runtime_count (), 1U);
}

// The control: the flag's default still records, so the tests above cannot
// pass by the console never recording at all.
TEST_F (ScriptEngineConsoleOffTest, ConsoleOnStillRecordsEveryLevel) {
    ScriptConfig cfg;
    cfg.enable_console = true;
    ScriptEngine loud (cfg);
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = loud.execute ("console.log('x'); console.info('y'); "
                                "console.warn('z'); console.error('w');",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.console_output.size (), 4u);
}

// The wire spellings are what the app matches on, so they are part of the
// contract rather than an implementation detail of the enum.
TEST_F (ScriptEngineTest, ConsoleLevelWireSpellings) {
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Log), "log");
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Info), "info");
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Warn), "warn");
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Error), "error");
}

// What one script execution may leave in its console (#3134). The caps are the
// constants themselves, so the tests move with them.
namespace console_limits = vayu::core::constants::script_engine;


TEST_F (ScriptEngineTest, ConsoleEntryCapKeepsTheCapAndOneMarker) {
    const auto result = engine.execute_test ("for (let i = 0; i < " +
    std::to_string (console_limits::CONSOLE_MAX_ENTRIES + 500) + "; i++) console.log ('line ' + i);",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), console_limits::CONSOLE_MAX_ENTRIES + 1);
    EXPECT_EQ (result.console_output[console_limits::CONSOLE_MAX_ENTRIES - 1].message,
    "line " + std::to_string (console_limits::CONSOLE_MAX_ENTRIES - 1));
    EXPECT_TRUE (is_console_limit_marker (result.console_output.back ()));
    EXPECT_EQ (console_limit_markers (result), 1u);
}

// The marker is for output that was dropped: a script that stops exactly at
// the cap lost nothing and gets none.
TEST_F (ScriptEngineTest, ConsoleAtExactlyTheEntryCapEmitsNoMarker) {
    const auto result = engine.execute_test ("for (let i = 0; i < " +
    std::to_string (console_limits::CONSOLE_MAX_ENTRIES) + "; i++) console.log ('line ' + i);",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.console_output.size (), console_limits::CONSOLE_MAX_ENTRIES);
    EXPECT_EQ (console_limit_markers (result), 0u);
}

// Lines each under the line cap, so only the total can stop them.
TEST_F (ScriptEngineTest, ConsoleTotalByteCapDropsWholeLinesAndEmitsOneMarker) {
    constexpr std::size_t line_bytes = 60000;
    static_assert (line_bytes < console_limits::CONSOLE_LINE_MAX_BYTES);
    const std::size_t lines_that_fit = console_limits::CONSOLE_TOTAL_MAX_BYTES / line_bytes;

    const auto result =
    engine.execute_test ("const line = 'x'.repeat (" + std::to_string (line_bytes) +
    ");"
    "for (let i = 0; i < " +
    std::to_string (lines_that_fit + 5) + "; i++) console.log (line);",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), lines_that_fit + 1);
    EXPECT_TRUE (is_console_limit_marker (result.console_output.back ()));
    EXPECT_EQ (console_limit_markers (result), 1u);

    std::size_t kept = 0;
    for (std::size_t i = 0; i < lines_that_fit; ++i) {
        EXPECT_EQ (result.console_output[i].message.size (), line_bytes);
        kept += result.console_output[i].message.size ();
    }
    EXPECT_LE (kept, console_limits::CONSOLE_TOTAL_MAX_BYTES);
}

TEST_F (ScriptEngineTest, ConsoleLineOverTheCapIsTruncatedWithAMarker) {
    const std::string over =
    std::to_string (console_limits::CONSOLE_LINE_MAX_BYTES + 1000);
    const auto result = engine.execute_test (
    "console.log ('x'.repeat (" + over + "));", request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), 1u);
    const std::string& message = result.console_output[0].message;
    EXPECT_EQ (message.substr (0, console_limits::CONSOLE_LINE_MAX_BYTES),
    std::string (console_limits::CONSOLE_LINE_MAX_BYTES, 'x'));
    EXPECT_NE (message.find ("[truncated"), std::string::npos);
    EXPECT_LT (message.size (), console_limits::CONSOLE_LINE_MAX_BYTES + 100);
}

TEST_F (ScriptEngineTest, ConsoleLineExactlyAtTheCapIsKeptWhole) {
    const auto result = engine.execute_test ("console.log ('x'.repeat (" +
    std::to_string (console_limits::CONSOLE_LINE_MAX_BYTES) + "));",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), 1u);
    EXPECT_EQ (result.console_output[0].message,
    std::string (console_limits::CONSOLE_LINE_MAX_BYTES, 'x'));
}

// A cut that lands inside a character must back up to the one before it, for
// each width UTF-8 has (2, 3 and 4 bytes).
TEST_F (ScriptEngineTest, ConsoleTruncationNeverSplitsAMultiByteCharacter) {
    struct Wide {
        const char* js;
        std::size_t bytes;
    };
    const std::array<Wide, 3> widths{ Wide{ "\\u00e9", 2 },
        Wide{ "\\u20ac", 3 }, Wide{ "\\ud83d\\ude00", 4 } };

    for (const auto& wide : widths) {
        // The character starts one byte short of the cap, so the cap falls
        // inside it for every width above 1.
        const std::size_t prefix = console_limits::CONSOLE_LINE_MAX_BYTES - 1;
        const auto result = engine.execute_test ("console.log ('a'.repeat (" +
        std::to_string (prefix) + ") + '" + wide.js + "' + 'tail');",
        request, response, env);

        ASSERT_TRUE (result.success) << result.error_message;
        ASSERT_EQ (result.console_output.size (), 1u);
        const std::string& message = result.console_output[0].message;
        EXPECT_TRUE (vayu::utils::is_valid_utf8_text (message))
        << wide.bytes << "-byte character";
        EXPECT_EQ (message.substr (0, prefix), std::string (prefix, 'a'));
        EXPECT_EQ (message.find ("tail"), std::string::npos);
        EXPECT_NE (message.find ("[truncated"), std::string::npos);
    }
}

// JSON.stringify flattens an Error, a Map and a Set to "{}" and quotes a Date;
// the console prints all four the way Node does (#3130).
class ConsoleFormatTest : public ScriptEngineTest {
    protected:
    // The one line a script logs.
    std::string run (const std::string& script) {
        const std::string full = script + "\npm.test('t', function () {});";
        auto result = engine.execute_test (full, request, response, env);
        EXPECT_TRUE (result.success) << result.error_message;
        EXPECT_EQ (result.console_output.size (), 1u);
        return result.console_output.empty () ? "" : result.console_output[0].message;
    }

    std::string logged (const std::string& expression) {
        return run ("console.log (" + expression + ");");
    }
};

TEST_F (ConsoleFormatTest, ErrorPrintsItsMessageAndStack) {
    auto message = logged ("new Error ('boom')");
    EXPECT_EQ (message.rfind ("Error: boom", 0), 0u) << message;
    EXPECT_NE (message.find ("\n    at "), std::string::npos)
    << "the stack follows the message line: " << message;
}

TEST_F (ConsoleFormatTest, ErrorNamesItsKindAndKeepsTheMessageOnce) {
    auto message = logged ("new TypeError ('bad type')");
    EXPECT_EQ (message.rfind ("TypeError: bad type", 0), 0u) << message;
    EXPECT_EQ (message.find ("bad type"), message.rfind ("bad type"))
    << "the message line is not repeated by the stack: " << message;
}

TEST_F (ConsoleFormatTest, ErrorWhoseStackAlreadyLeadsWithTheMessageIsNotDoubled) {
    EXPECT_EQ (run (R"(
        var e = new Error ('boom');
        e.stack = 'Error: boom\n    at here\n';
        console.log (e);
    )"),
    "Error: boom\n    at here");
}

TEST_F (ConsoleFormatTest, ErrorWithAnEmptyStackPrintsItsStringForm) {
    EXPECT_EQ (run (R"(
        var e = new Error ('boom');
        e.stack = '';
        console.log (e);
    )"),
    "Error: boom");
}

TEST_F (ConsoleFormatTest, MapPrintsItsEntries) {
    EXPECT_EQ (logged ("new Map ([[1, 2]])"), "Map(1) {1 => 2}");
    EXPECT_EQ (logged ("new Map ([['a', 1], ['b', 2]])"), R"(Map(2) {"a" => 1, "b" => 2})");
    EXPECT_EQ (logged ("new Map ()"), "Map(0) {}");
}

TEST_F (ConsoleFormatTest, MapEntriesRenderNestedObjectsAndUnserializableValues) {
    EXPECT_EQ (logged ("new Map ([['k', { a: [1, 2] }]])"), R"(Map(1) {"k" => {"a":[1,2]}})");
    EXPECT_EQ (logged ("new Map ([[1, undefined]])"), "Map(1) {1 => undefined}");
    EXPECT_EQ (logged ("new Map ([[1, Symbol ('s')]])"), "Map(1) {1 => [unserializable]}");
}

TEST_F (ConsoleFormatTest, SetPrintsItsValues) {
    EXPECT_EQ (logged ("new Set ([1])"), "Set(1) {1}");
    EXPECT_EQ (logged ("new Set (['a', 'b'])"), R"(Set(2) {"a", "b"})");
    EXPECT_EQ (logged ("new Set ()"), "Set(0) {}");
}

TEST_F (ConsoleFormatTest, ACollectionStillPrintsWhenAScriptReplacesArrayFrom) {
    // The members are read through Array.from; when that is gone the line
    // degrades to the generic path rather than throwing.
    EXPECT_EQ (logged ("(Array.from = undefined, new Set ([1]))"), "{}");
}

TEST_F (ConsoleFormatTest, DatePrintsAnUnquotedIsoString) {
    EXPECT_EQ (logged ("new Date (0)"), "1970-01-01T00:00:00.000Z");
    EXPECT_EQ (logged ("new Date (NaN)"), "Invalid Date");
}

TEST_F (ConsoleFormatTest, OtherObjectsAreStillPrettyPrintedJson) {
    EXPECT_EQ (logged ("{ a: 1 }"), "{\n  \"a\": 1\n}");
    EXPECT_EQ (logged ("[1, 2]"), "[\n  1,\n  2\n]");
}

// ============================================================================
// Script Parts: Shared Scope
// ============================================================================

// Pins the property the whole script-parts feature depends on: parts joined
// by vayu::http::read_script and run through a single engine.execute() call
// share one JavaScript scope, so a const declared in an earlier part is
// visible to a later one. This does not catch someone splitting the execute
// call apart in execution.cpp (a source-level regression, not a behavioral
// one this test can see) - it only pins read_script's join, run once,
// behaving as documented.
TEST_F (ScriptEngineTest, ComposedPartsShareOneScope) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":"const shared = 42;"},
        {"origin":"request","script":"console.log(\"got \" + shared);"}
      ]
    })");
    auto script = vayu::http::read_script (json, "preRequestScripts", "preRequestScript");

    ScriptContext ctx;
    ctx.request = &request;
    auto result = engine.execute (script, ctx);

    EXPECT_TRUE (result.success);
    ASSERT_GE (result.console_output.size (), 1);
    EXPECT_EQ (result.console_output[0].message, "got 42");
}

// ============================================================================
// Error Handling Tests
// ============================================================================

TEST_F (ScriptEngineTest, SyntaxError) {
    auto result = engine.execute_test (R"(
        pm.test("Bad syntax", function() {
            var x = ;  // Syntax error
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_FALSE (result.error_message.empty ());
}

TEST_F (ScriptEngineTest, RuntimeError) {
    auto result = engine.execute_test (R"(
        pm.test("Runtime error", function() {
            undefinedFunction();  // Reference error
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
}

// ============================================================================
// Pre-request Script Tests
// ============================================================================

TEST_F (ScriptEngineTest, PreRequestScript) {
    Request req;
    req.method = HttpMethod::GET;
    req.url    = "https://api.example.com";

    auto result = engine.execute_prerequest (R"(
        console.log("Pre-request script running");
        pm.environment.set("timestamp", Date.now().toString());
    )",
    req, env);

    EXPECT_TRUE (result.success);
    EXPECT_TRUE (env.find ("timestamp") != env.end ());
}

// ============================================================================
// Script Execution Timeout Tests (#107)
// ============================================================================

// A non-allocating infinite loop must be interrupted by the wall-clock deadline
// rather than hanging the calling thread. Mutation-check: revert the
// JS_SetInterruptHandler wiring in acquire_context/execute and this test hangs.
TEST_F (ScriptEngineTest, InfiniteLoopTimesOut) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 200;
    ScriptEngine timeout_engine (cfg);

    ScriptContext ctx;
    ctx.response = &response;

    const auto start   = std::chrono::steady_clock::now ();
    auto result        = timeout_engine.execute ("while (true) {}", ctx);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - start)
                         .count ();

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("timed out"), std::string::npos)
    << "error was: " << result.error_message;
    // Should abort near the deadline, not run indefinitely. Generous upper bound to
    // stay robust on slow CI while still proving the loop does not run forever.
    EXPECT_LT (elapsed, 5000) << "took " << elapsed << "ms";
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// A fast script under the limit must not be falsely aborted by the deadline.
TEST_F (ScriptEngineTest, FastScriptUnderTimeoutStillPasses) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 200;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("Fast test", function() {
            pm.expect(1).to.equal(1);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_TRUE (result.error_message.empty ());
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed);
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// #1056. The deadline is enforced by raising an exception into the running
// call, so an assertion that calls back into the script sees the engine's abort
// and a value the script threw as the same thing. `.to.throw()` read that as
// "the function threw" and reported a green verdict about a function that never
// returned - the silent-false-pass quadrant #996 exists to close.
//
// Mutation check: restore the "any pending exception is a throw" reading in
// expect_throw (drop the script_deadline_expired guard) and this reddens - the
// script runs to completion with the assertion satisfied.
TEST_F (ScriptEngineTest, ThrowMatcherAbortsWhenTheTargetOutlivesTheDeadline) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (
    R"(pm.expect(function () { while (true) {} }).to.throw();)", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("timed out"), std::string::npos)
    << "error was: " << result.error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The same target inside a pm.test, which is how the issue reproduced it:
// pm.test records any exception from its callback as a failure, so the abort
// arrives as a FAIL rather than as the PASS today's code reports. This is the
// verdict half of the criterion and does not depend on whether the interrupt
// re-fires before the script ends.
TEST_F (ScriptEngineTest, ThrowMatcherReportsFailForATargetPastTheDeadline) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("a function that never returns", function () {
            pm.expect(function () { while (true) {} }).to.throw();
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed)
    << "a spinning target reported a pass: " << result.tests[0].error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The other side of the fix: an ordinary throw under the same short timeout
// still satisfies `.to.throw()`, in both the bare and the constructor form. A
// guard that turned every throw into an abort would pass the two tests above.
TEST_F (ScriptEngineTest, OrdinaryThrowStillSatisfiesThrowUnderAShortTimeout) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("throws", function () {
            pm.expect(function () { throw new Error("boom"); }).to.throw();
            pm.expect(function () { throw new TypeError("bad"); }).to.throw(TypeError, "bad");
            pm.expect(function () { return 1; }).to.not.throw();
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success) << "error was: " << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The flag answers about the call just made, not about the execution so far,
// and that distinction is reachable from a script: `pm.test` consumes an abort
// natively and lets the script run on with a fresh 10,000-operation budget
// before QuickJS polls again, so a second test in the same script is judged
// after a deadline has already blown. Its ordinary throw is still an ordinary
// throw. Mutation check: drop the `arm_script_deadline_watch` call before
// `JS_Call` in expect_throw - leaving the once-per-execution reset alone - and
// the second test reports FAIL with "Error: boom" instead of passing.
TEST_F (ScriptEngineTest, AThrowAfterACaughtDeadlineAbortIsStillJudgedOnItsOwn) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("spins past the deadline", function () {
            pm.expect(function () { while (true) {} }).to.throw();
        });
        pm.test("an ordinary throw afterwards", function () {
            pm.expect(function () { throw new Error("boom"); }).to.throw();
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_TRUE (result.tests[1].passed)
    << "an ordinary throw was read as the earlier abort: "
    << result.tests[1].error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// `.satisfy` is the other matcher that calls back into the script. It already
// propagated the exception rather than reading it as a verdict; this pins that
// it stays so, since the audit that established it is otherwise unrecorded.
TEST_F (ScriptEngineTest, SatisfyPredicatePastTheDeadlineAbortsTheScript) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (
    R"(pm.expect(1).to.satisfy(function () { while (true) {} });)", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("timed out"), std::string::npos)
    << "error was: " << result.error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// #1073. The message half of the same question the three tests above settled
// for the verdict: `execute` asked the *clock* whether the deadline ended the
// script, so an error that merely landed past it was relabelled a timeout and
// the sentence naming the fault was discarded. Here the deadline has provably
// passed and the handler stopped nothing since - the `arm` before the second
// `.to.throw()` clears its record, which is what makes the top-level throw
// below the only thing that ended this script.
//
// Mutation check: restore the `steady_clock::now () > deadline` comparison in
// `Impl::execute` and this reddens on "Script execution timed out after 300ms".
TEST_F (ScriptEngineTest, AnOwnThrowPastTheDeadlineKeepsItsOwnError) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("spins past the deadline", function () {
            pm.expect(function () { while (true) {} }).to.throw();
        });
        pm.expect(function () { throw new Error("caught by the matcher"); }).to.throw();
        throw new Error("the script's own error");
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("the script's own error"), std::string::npos)
    << "error was: " << result.error_message;
    EXPECT_EQ (result.error_message.find ("timed out"), std::string::npos)
    << "an ordinary throw was relabelled a timeout: " << result.error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// timeout_ms == 0 disables the wall-clock limit (escape hatch); a bounded loop
// still completes normally with no false timeout.
TEST_F (ScriptEngineTest, ZeroTimeoutDisablesLimit) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 0;
    ScriptEngine no_timeout_engine (cfg);

    ScriptContext ctx;
    auto result = no_timeout_engine.execute (
    "var n = 0; for (var i = 0; i < 100000; i++) { n += i; } n", ctx);

    EXPECT_TRUE (result.success);
    EXPECT_TRUE (result.error_message.empty ());
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// ============================================================================
// The sandbox's global surface
// ============================================================================
//
// `scripting.md` now teaches request rewriting, so what a script can *compute*
// is part of the contract. Installed on top of QuickJS's built-ins: `console`,
// `pm`, `btoa` / `atob` (#187), and `require` / `CryptoJS` (#2578). Still
// absent: a URL parser and `fetch`. This pins both halves so a doc example
// cannot come to rely on something that was never there (`scripting.md` used
// to show a `computeHash` that does not exist).

TEST_F (ScriptEngineTest, StandardBuiltinsAreAvailableToScripts) {
    auto result = engine.execute_prerequest (R"JS(
        var missing = [];
        var expected = ['JSON', 'Date', 'Math', 'RegExp', 'String', 'Array',
                        'Object', 'Number', 'encodeURIComponent', 'parseInt'];
        for (var i = 0; i < expected.length; i++) {
            if (typeof globalThis[expected[i]] === 'undefined') missing.push(expected[i]);
        }
        pm.environment.set('missing', missing.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "a built-in the docs rely on disappeared";
}

// `require` is not among them: it answers a fixed shelf and loads nothing
// else (#2578, the RequireShelf tests below).
TEST_F (ScriptEngineTest, NoUrlParserOrFetchIsExposed) {
    auto result = engine.execute_prerequest (R"JS(
        var present = [];
        var absent = ['crypto', 'TextEncoder', 'URL', 'URLSearchParams', 'fetch'];
        for (var i = 0; i < absent.length; i++) {
            if (typeof globalThis[absent[i]] !== 'undefined') present.push(absent[i]);
        }
        pm.environment.set('present', present.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // If one of these ever lands, the "what a script can compute" section in
    // scripting.md stops being true and should be rewritten, not left standing.
    // `crypto` in particular: a global of that name is a promise of Web Crypto's
    // whole surface, which this sandbox does not implement - which is why the
    // hashing surface is pm.crypto and synchronous.
    EXPECT_EQ (env["present"].value, "")
    << "a new global is available - update the 'What a script can compute' "
       "section in scripting.md";
}

TEST_F (ScriptEngineTest, Base64AndHashingGlobalsAreInstalled) {
    auto result = engine.execute_prerequest (R"JS(
        var missing = [];
        if (typeof btoa !== 'function') missing.push('btoa');
        if (typeof atob !== 'function') missing.push('atob');
        if (typeof pm.crypto !== 'object') missing.push('pm.crypto');
        if (typeof pm.crypto.sha256 !== 'function') missing.push('pm.crypto.sha256');
        if (typeof pm.crypto.hmacSha256 !== 'function') missing.push('pm.crypto.hmacSha256');
        pm.environment.set('missing', missing.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "the signing surface #187 added is incomplete - scripting.md and "
       "pm-api-compatibility.md teach these names";
}

// ============================================================================
// What a script error reads as when the thrown value says nothing (#3461)
// ============================================================================

namespace {

constexpr size_t ONE_MIB = size_t{ 1 } * 1024 * 1024;

// `scriptMemoryLimit`'s floor, the one a library as large as lodash cannot be
// loaded under.
ScriptConfig minimum_memory_config () {
    ScriptConfig cfg;
    cfg.memory_limit = ONE_MIB;
    return cfg;
}

// What the out-of-memory sentence reads as at @p limit bytes, with the limit
// in the unit `scriptMemoryLimit` would be chosen in.
std::string out_of_memory_sentence (size_t limit) {
    std::string named = std::to_string (limit) + " bytes";
    if (limit % ONE_MIB == 0) {
        named = std::to_string (limit / ONE_MIB) + " MiB";
    } else if (limit % 1024 == 0) {
        named = std::to_string (limit / 1024) + " KiB";
    }
    return "Script ran out of memory at the " + named + " limit";
}

constexpr std::string_view ALLOCATION_LOOP =
"const held = []; for (;;) { held.push(new Array(1000).fill(1)); }";

} // namespace

// Where the limit refuses moves with every allocation a context makes before
// the script runs, and QuickJS words the refusal by where it lands: its own
// out-of-memory error, a bare null when there was no room to build that, or a
// `SyntaxError` its parser raises instead. The report is the script heap's
// record of the refusal, so it is the one sentence at every layout: the
// window of limits stands for layouts another platform's allocator makes.
// Mutation check: drop `refused` from `restore_out_of_memory_error` and
// limits in the window report `SyntaxError: invalid assignment left-hand side`.
TEST_F (ScriptEngineTest, RequiringLodashAtTheMinimumMemoryLimitReportsOutOfMemory) {
    constexpr size_t WINDOW = 32;
    constexpr size_t STEP   = 64;
    for (size_t i = 0; i < WINDOW; ++i) {
        ScriptConfig cfg;
        cfg.memory_limit = ONE_MIB + (i * STEP);
        ScriptEngine bounded (cfg);
        auto ctx    = ScriptContext::for_test (request, response);
        auto result = bounded.execute ("const _ = require('lodash');", ctx);
        EXPECT_FALSE (result.success) << "at " << cfg.memory_limit << " bytes";
        EXPECT_EQ (result.error_message, out_of_memory_sentence (cfg.memory_limit));
    }
}

// The loop runs out at a different point at each limit, and with no room left
// QuickJS throws a bare null, which reads as the out-of-memory sentence because
// the heap refused. Mutation check: drop `refused && JS_IsNull` from
// `thrown_value_message` and limits in the window read "Script threw null".
TEST_F (ScriptEngineTest, AnAllocationLoopAtTheMemoryLimitReportsOutOfMemory) {
    constexpr size_t WINDOW = 32;
    constexpr size_t STEP   = 64;
    for (size_t i = 0; i < WINDOW; ++i) {
        ScriptConfig cfg;
        cfg.memory_limit = ONE_MIB + (i * STEP);
        ScriptEngine bounded (cfg);
        auto ctx    = ScriptContext::for_test (request, response);
        auto result = bounded.execute (std::string (ALLOCATION_LOOP), ctx);
        EXPECT_FALSE (result.success);
        EXPECT_EQ (result.error_message, out_of_memory_sentence (cfg.memory_limit));
    }
}

TEST_F (ScriptEngineTest, TheOutOfMemorySentenceNamesTheConfiguredLimit) {
    ScriptConfig cfg;
    cfg.memory_limit = size_t{ 2 } * 1024 * 1024;
    ScriptEngine bounded (cfg);
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = bounded.execute (std::string (ALLOCATION_LOOP), ctx);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script ran out of memory at the 2 MiB limit");
}

// A script whose bytecode alone needs more than the limit fails inside the
// parser, where QuickJS can drop the refused write to its bytecode buffer and
// then read the assignment it lost as `SyntaxError: invalid assignment
// left-hand side` (what Linux measures). Whichever error QuickJS raised, the
// sentence leads. Mutation check: return `text` whatever `refused` says in
// `thrown_value_message` and the message is the bare `SyntaxError`.
TEST_F (ScriptEngineTest, AScriptTooLargeToCompileUnderTheLimitReportsOutOfMemory) {
    std::string script = "let a = 0;\n";
    for (int i = 0; i < 200000; ++i) {
        script += "a = 1;\n";
    }
    ScriptEngine bounded (minimum_memory_config ());
    auto ctx          = ScriptContext::for_test (request, response);
    const auto result = bounded.execute (script, ctx);
    EXPECT_FALSE (result.success);
    EXPECT_TRUE (result.error_message.starts_with (out_of_memory_sentence (ONE_MIB)))
    << result.error_message;
}

// A test row that ran out of memory reports it, and the rows after it report
// their own errors: the refusal belongs to the call that met it. Mutation
// check: drop the `AllocationRefusalWatch` from `pm.test` and the second row
// reads "... (then failed with: Error: boom)".
TEST_F (ScriptEngineTest, ARowThatRanOutOfMemoryLeavesTheNextRowsErrorItsOwn) {
    ScriptEngine bounded (minimum_memory_config ());
    const auto result = bounded.execute_test ("pm.test('a', () => { " +
    std::string (ALLOCATION_LOOP) + " }); pm.test('b', () => { throw new Error('boom'); });",
    request, response, env);
    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_EQ (result.tests[0].error_message, out_of_memory_sentence (ONE_MIB));
    EXPECT_EQ (result.tests[1].error_message, "Error: boom");
}

// The same holds for the legacy `tests[name]` rows, whose getters run after
// the script. Mutation check: drop the watch from `legacy_test_result`.
TEST_F (ScriptEngineTest, ALegacyRowThatRanOutOfMemoryLeavesTheNextRowsErrorItsOwn) {
    ScriptEngine bounded (minimum_memory_config ());
    const auto result = bounded.execute_test (
    "Object.defineProperty(tests, 'a', { enumerable: true, get() { " +
    std::string (ALLOCATION_LOOP) +
    " } }); Object.defineProperty(tests, 'b', { enumerable: true, get() { "
    "throw new Error('boom'); } });",
    request, response, env);
    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_EQ (result.tests[0].error_message, out_of_memory_sentence (ONE_MIB));
    EXPECT_EQ (result.tests[1].error_message, "Error: boom");
}

// A script's own `throw null` meets no refused allocation, so it reads as
// what it is at any limit.
TEST_F (ScriptEngineTest, AThrownNullIsNeverReportedAsABareNull) {
    ScriptEngine bounded (minimum_memory_config ());
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = bounded.execute ("throw null;", ctx);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script threw null");
}

TEST_F (ScriptEngineTest, AThrownNullWithNoMemoryLimitIsOnlyANull) {
    ScriptConfig cfg;
    cfg.memory_limit = 0;
    ScriptEngine unbounded (cfg);
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = unbounded.execute ("throw null;", ctx);
    EXPECT_EQ (result.error_message, "Script threw null");
}

TEST_F (ScriptEngineTest, AThrownUndefinedReadsAsASentence) {
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = engine.execute ("throw undefined;", ctx);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script threw undefined");
}

TEST_F (ScriptEngineTest, AnErrorWithAnEmptyMessageReadsAsItsType) {
    auto plain       = ScriptContext::for_test (request, response);
    auto plain_error = engine.execute ("throw new Error('');", plain);
    EXPECT_EQ (plain_error.error_message, "Error");

    auto typed      = ScriptContext::for_test (request, response);
    auto type_error = engine.execute ("throw new TypeError('');", typed);
    EXPECT_EQ (type_error.error_message, "TypeError");
}

TEST_F (ScriptEngineTest, AThrownErrorWithAMessageIsUnchanged) {
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = engine.execute ("throw new Error('boom');", ctx);
    EXPECT_EQ (result.error_message, "Error: boom");
}

TEST_F (ScriptEngineTest, AThrownValueWithNoTextReadsAsASentence) {
    auto empty_string = ScriptContext::for_test (request, response);
    EXPECT_EQ (engine.execute ("throw '';", empty_string).error_message,
    "Script threw an empty string");

    auto blank = ScriptContext::for_test (request, response);
    EXPECT_EQ (engine.execute ("throw { toString() { return ''; } };", blank).error_message,
    "Script threw a value with no text");

    // A `toString` that itself throws leaves nothing pending behind.
    auto hostile = ScriptContext::for_test (request, response);
    EXPECT_EQ (engine.execute ("throw { toString() { throw 1; } };", hostile).error_message,
    "Script threw a value with no text");
}

TEST_F (ScriptEngineTest, ARejectionAndATimerThrowReadAsSentencesToo) {
    auto rejected = ScriptContext::for_test (request, response);
    auto result   = engine.execute ("Promise.reject(undefined);", rejected);
    EXPECT_EQ (result.error_message, "Unhandled promise rejection: Script threw undefined");

    auto timed = ScriptContext::for_test (request, response);
    result = engine.execute ("setTimeout(() => { throw undefined; }, 0);", timed);
    EXPECT_EQ (result.error_message, "Script threw undefined");
}

// A `pm.test` row names its failure the way a script error does (#3461): the
// row is where a user reads it, so a bare `null` there is the same dead end.
TEST_F (ScriptEngineTest, ATestRowThatThrowsNullReadsAsASentence) {
    ScriptEngine bounded (minimum_memory_config ());
    const auto result = bounded.execute_test (
    "pm.test('x', function () { throw null; });", request, response, env);
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_EQ (result.tests[0].error_message, "Script threw null");
}

TEST_F (ScriptEngineTest, ATestRowThatThrowsNullWithNoMemoryLimitIsOnlyANull) {
    ScriptConfig cfg;
    cfg.memory_limit = 0;
    ScriptEngine unbounded (cfg);
    const auto result = unbounded.execute_test (
    "pm.test('x', function () { throw null; });", request, response, env);
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_EQ (result.tests[0].error_message, "Script threw null");
}

TEST_F (ScriptEngineTest, ATestRowThatThrowsUndefinedOrAnEmptyErrorReadsAsASentence) {
    EXPECT_EQ (verdict_of ("throw undefined"), "Script threw undefined");
    EXPECT_EQ (verdict_of ("throw new Error('')"), "Error");
    EXPECT_EQ (verdict_of ("throw ''"), "Script threw an empty string");
}

TEST_F (ScriptEngineTest, ATestRowThatThrowsAnErrorWithAMessageIsUnchanged) {
    EXPECT_EQ (verdict_of ("throw new Error('boom')"), "Error: boom");
}

// The legacy `tests[name]` row can fail the same way: a getter the script
// defined on the object is the row's verdict when it throws.
TEST_F (ScriptEngineTest, ALegacyTestRowWhoseGetterThrowsNullReadsAsASentence) {
    ScriptConfig cfg;
    cfg.memory_limit = 0;
    ScriptEngine unbounded (cfg);
    const auto result =
    unbounded.execute_test ("Object.defineProperty(tests, 'x', { enumerable: "
                            "true, get() { throw undefined; } });",
    request, response, env);
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_EQ (result.tests[0].error_message, "Script threw undefined");
}

namespace {

/// What one execution's first `Math.random()` answers, as the string the
/// script wrote to the environment; empty when the script did not run.
std::string first_random_draw (ScriptEngine& engine, Request& request) {
    Environment env;
    const auto result = engine.execute_prerequest (
    "pm.environment.set('draw', String(Math.random()));", request, env);
    if (!result.success || env.find ("draw") == env.end ()) {
        return {};
    }
    return env["draw"].value;
}

} // namespace

// #3460: QuickJS seeds a context's `Math.random` from the microsecond clock,
// and every execution builds a context. A draw is a number in [0, 1) and the
// contexts of one thread continue one sequence rather than each restarting.
TEST_F (ScriptEngineTest, MathRandomAnswersAUnitIntervalNumberThatDiffersBetweenContexts) {
    const auto first  = first_random_draw (engine, request);
    const auto second = first_random_draw (engine, request);

    ASSERT_FALSE (first.empty ());
    ASSERT_FALSE (second.empty ());
    EXPECT_NE (first, second);
    for (const auto& draw : { first, second }) {
        const double value = std::stod (draw);
        EXPECT_GE (value, 0.0) << draw;
        EXPECT_LT (value, 1.0) << draw;
    }
}

// Threads released together build their contexts in the same few microseconds,
// which is when a clock-seeded generator hands two of them one sequence. Each
// round starts fresh threads at a latch, with the runtime already built, so
// the contexts are as close in time as the scheduler allows. A hit on the
// clock-seeded generator is a matter of chance per round, so the rounds are
// many and cheap. Mutation check: drop `setup_math_random` from
// `build_context` and a round collides.
TEST_F (ScriptEngineTest, MathRandomDoesNotRepeatAcrossThreadsStartingTogether) {
    constexpr size_t THREADS = 4;
    constexpr size_t ROUNDS  = 400;

    size_t colliding_rounds = 0;
    for (size_t round = 0; round < ROUNDS; ++round) {
        std::latch released (THREADS);
        std::vector<std::string> draws (THREADS);
        std::vector<std::thread> threads;
        threads.reserve (THREADS);
        for (size_t i = 0; i < THREADS; ++i) {
            threads.emplace_back ([&, i] {
                ScriptEngine worker;
                Request worker_request = request;
                (void)first_random_draw (worker, worker_request);
                released.arrive_and_wait ();
                draws[i] = first_random_draw (worker, worker_request);
            });
        }
        for (auto& thread : threads) {
            thread.join ();
        }

        const std::set<std::string> distinct (draws.begin (), draws.end ());
        if (distinct.size () != THREADS || distinct.contains ("")) {
            ++colliding_rounds;
        }
    }
    EXPECT_EQ (colliding_rounds, 0u);
}

// #3460: `ScriptContext::stop` ends the script itself, not only its sends, and
// a script it ended is `cancelled`, never `timed_out`. Mutation check: drop the
// `stop` check from `script_interrupt_handler` and the script runs out its
// deadline instead.
TEST_F (ScriptEngineTest, ARaisedStopEndsARunningScriptAsCancelled) {
    ScriptConfig cfg;
    cfg.timeout_ms = 2000;
    ScriptEngine bounded (cfg);
    const std::atomic<bool> stop{ true };
    auto ctx = ScriptContext::for_test (request, response);
    ctx.stop = &stop;

    const auto result = bounded.execute ("while (true) {}", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_TRUE (result.cancelled);
    EXPECT_FALSE (result.timed_out);
    EXPECT_TRUE (result.ended_by_stop ());
}

// The stop is read before every timer callback too, which runs no bytecode
// before its first poll. Mutation check: drop the `stop` check from
// `async_budget_spent` and the callback runs.
TEST_F (ScriptEngineTest, ARaisedStopRunsNoTimerCallback) {
    const std::atomic<bool> stop{ true };
    Environment stopped_env;
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &stopped_env;
    ctx.stop        = &stop;

    const auto result =
    engine.execute ("setTimeout(() => pm.environment.set('ran', 'yes'), 0);", ctx);

    EXPECT_TRUE (result.cancelled);
    EXPECT_EQ (stopped_env.find ("ran"), stopped_env.end ());
}

TEST_F (ScriptEngineTest, AScriptThatRunsOutItsDeadlineIsTimedOut) {
    ScriptConfig cfg;
    cfg.timeout_ms = 50;
    ScriptEngine bounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    const auto result = bounded.execute ("while (true) {}", ctx);

    EXPECT_TRUE (result.timed_out);
    EXPECT_FALSE (result.cancelled);
    EXPECT_EQ (result.error_message, "Script execution timed out after 50ms");
}
