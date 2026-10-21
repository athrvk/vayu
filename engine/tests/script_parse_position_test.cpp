/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_parse_position_test.cpp
 * @brief Parsing a one-line script is linear, and its positions are unchanged (#2657).
 *
 * The vendored QuickJS parser found each identifier's column by scanning back
 * to the start of its line, so a single-line (minified) script cost time
 * quadratic in its length. The patch remembers the previous answer
 * (`identifier_line_start` in `vendor/quickjs-ng/quickjs.c`). Two things have
 * to hold at once: the time, and the `line:column` a script's own stack
 * reports, which must stay exactly what the full scan answered.
 *
 * The expected positions below were measured on the engine with the patch
 * reverted, and every one of them also passes with it applied. The first frame
 * of a stack is `<script>:line:column`, and on line 1 the column includes the
 * 20 characters of the wrapper's own prefix.
 *
 * Mutation-check: revert the `quickjs.c` hunk and `ALongOneLineScriptParsesInLinearTime`
 * fails (the 400 KB script then takes seconds, not milliseconds) while the
 * position tests stay green; drop the `'\r'` test from the scan loop in
 * `identifier_line_start` and the `\r` case fails.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <string>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "wide_json.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

class ScriptParsePositionTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    ScriptResult run (const std::string& script) {
        auto ctx        = ScriptContext::for_test (request, response);
        ctx.environment = &env;
        return engine.execute (script, ctx);
    }

    /** Runs @p script, which ends by storing an `Error` stack as `stack`. */
    std::string stack_of (const std::string& script) {
        const auto result = run (script);
        EXPECT_TRUE (result.success) << result.error_message;
        return env["stack"].value;
    }
};

/** Throws a `ReferenceError` on the identifier `missing` and keeps its stack. */
constexpr const char* CATCH_MISSING =
"try { missing; } catch (e) { pm.environment.set('stack', e.stack); }";

TEST_F (ScriptParsePositionTest, AnErrorOnALaterLineNamesItsLineAndColumn) {
    EXPECT_EQ (stack_of (std::string ("var a=1;\nvar b=2;\n  ") + CATCH_MISSING),
    "    at <anonymous> (<script>:3:9)\n    at <eval> (<script>:4:1)\n");
}

// Both characters end a line for the column, as they do for the line number.
TEST_F (ScriptParsePositionTest, CarriageReturnLineEndingsGiveTheSamePosition) {
    EXPECT_EQ (stack_of (std::string ("var a=1;\r\nvar b=2;\r\n  ") + CATCH_MISSING),
    "    at <anonymous> (<script>:3:9)\n    at <eval> (<script>:4:1)\n");
    EXPECT_EQ (stack_of (std::string ("var a=1;\rvar b=2;\r  ") + CATCH_MISSING),
    "    at <anonymous> (<script>:3:9)\n    at <eval> (<script>:4:1)\n");
}

TEST_F (ScriptParsePositionTest, AnErrorOnAOneLineScriptNamesItsColumn) {
    EXPECT_EQ (stack_of (std::string ("var a=1;var b=2;a=b+a;") + CATCH_MISSING),
    "    at <anonymous> (<script>:1:49)\n    at <eval> (<script>:2:1)\n");
}

// An arrow function's parameter list is scanned ahead and then parsed again,
// so the parser revisits earlier source after later source was measured.
TEST_F (ScriptParsePositionTest, AnArrowFunctionOnOneLineKeepsItsPositions) {
    EXPECT_EQ (
    stack_of (std::string ("var f=(a,b)=>a+b;var g=(p)=>p;f(1,2);g(3);") + CATCH_MISSING),
    "    at <anonymous> (<script>:1:69)\n    at <eval> (<script>:2:1)\n");
    EXPECT_EQ (stack_of ("var f=(a,b)=>a+b+missing;try{f(1,2)}catch(e){"
                         "pm.environment.set('stack',e.stack)}"),
    "    at f (<script>:1:38)\n    at <anonymous> (<script>:1:49)\n"
    "    at <eval> (<script>:2:1)\n");
}

// A line that ends and another that goes on for a long time, with the failing
// identifier on the second: the answer for it must not be the first line's.
TEST_F (ScriptParsePositionTest, ALongLineAfterALineBreakIsMeasuredFromItsOwnStart) {
    std::string script = "var a=1;\n";
    for (int i = 0; i < 50; ++i) {
        script += "a=a+a;";
    }
    EXPECT_EQ (stack_of (script + std::string (CATCH_MISSING)),
    "    at <anonymous> (<script>:2:307)\n    at <eval> (<script>:3:1)\n");
}

// Healthy: about 50 ms at -O2 and 130 ms in a Debug build, so a sanitizer leg
// stays far under its budget. Quadratic: 43 s in a Debug build and about 20 s
// at -O2 (a 74 KB script already took 279 ms), which is past the budget on
// every leg. The bound is the suite's linear-parse budget, a hang detector
// between those two readings, not a speed check.
TEST_F (ScriptParsePositionTest, ALongOneLineScriptParsesInLinearTime) {
    constexpr std::size_t STATEMENTS = 70'000;
    std::string script               = "var a=1,b=2,c=3;";
    script.reserve ((STATEMENTS * 6) + 64);
    for (std::size_t i = 0; i < STATEMENTS; ++i) {
        script += "a=b+c;";
    }
    script += "pm.environment.set('a', String(a));";
    ASSERT_GT (script.size (), std::size_t{ 400'000 });
    ASSERT_EQ (script.find ('\n'), std::string::npos);

    const auto start   = std::chrono::steady_clock::now ();
    const auto result  = run (script);
    const auto elapsed = std::chrono::steady_clock::now () - start;

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["a"].value, "5");
    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET)
    << "a 400 KB one-line script took "
    << std::chrono::duration_cast<std::chrono::milliseconds> (elapsed).count () << " ms";
}

} // namespace
