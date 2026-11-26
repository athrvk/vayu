#pragma once

/**
 * @file script_engine_fixture.hpp
 * @brief The `ScriptEngineTest` fixture and the helpers shared by more than one
 *        `script_engine_*_test.cpp`.
 *
 * The suite is split by `pm.*` area across those files and keeps one name, so
 * `--gtest_filter=ScriptEngineTest.*` and the ctest regexes see it whole. The
 * class is defined here, once, so each translation unit sees the same type;
 * gtest refuses a suite whose `TEST_F`s name different fixture classes.
 */

#include <algorithm>
#include <cstddef>
#include <string>

#include <gtest/gtest.h>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

class ScriptEngineTest : public ::testing::Test {
    protected:
    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;

    void SetUp () override {
        // Setup default request
        request.method  = vayu::HttpMethod::GET;
        request.url     = "https://api.example.com/users";
        request.headers = { { "Content-Type", "application/json" },
            { "Authorization", "Bearer token123" } };

        // Setup default response
        response.status_code = 200;
        response.status_text = "OK";
        response.body = R"({"id": 1, "name": "John Doe", "email": "john@example.com"})";
        response.headers         = { { "Content-Type", "application/json" },
            { "X-Request-Id", "abc123" } };
        response.timing.total_ms = 150.5;

        // Setup environment
        env["api_key"] = vayu::Variable{ "secret123", true, true };
        env["base_url"] = vayu::Variable{ "https://api.example.com", false, true };
    }

    /**
     * Runs one assertion inside a `pm.test`. Answers an empty string when it
     * held and the report's error text when it did not, so a case can assert
     * both that it failed and what it said.
     */
    std::string verdict_of (const std::string& assertion) {
        const std::string script = "pm.test(\"t\", function() {\n" + assertion + ";\n});";
        const auto result = engine.execute_test (script, request, response, env);
        if (result.tests.size () != 1u) {
            return "<no test recorded for: " + assertion + ">";
        }
        return result.tests[0].passed ? std::string{} : result.tests[0].error_message;
    }
};

namespace vayu::tests {

/// A pre-request context that declares itself part of a sequence, which is the
/// scenario runner's shape and nothing else's.
inline runtime::ScriptContext scenario_prerequest (Request& request, Environment& env) {
    runtime::ScriptContext ctx = runtime::ScriptContext::for_prerequest (request);
    ctx.environment = &env;
    ctx.in_scenario = true;
    return ctx;
}

inline runtime::ScriptContext
scenario_test (const Request& request, const Response& response, Environment& env) {
    runtime::ScriptContext ctx = runtime::ScriptContext::for_test (request, response);
    ctx.environment = &env;
    ctx.in_scenario = true;
    return ctx;
}

inline bool is_console_limit_marker (const ConsoleEntry& entry) {
    return entry.level == ConsoleLevel::Warn &&
    entry.message.find ("console output limit reached") != std::string::npos;
}

inline std::size_t console_limit_markers (const ScriptResult& result) {
    return static_cast<std::size_t> (
    std::ranges::count_if (result.console_output, is_console_limit_marker));
}

inline constexpr const char* JEFE_MESSAGE = "what do ya want for nothing?";

struct ShelfAnswer {
    const char* expression;
    const char* expected;
};

/// What @p expression, run as a pre-request script, stringifies to; the
/// script's error when it throws.
inline std::string
shelf_answer (runtime::ScriptEngine& engine, Request& request, const std::string& expression) {
    Environment env;
    const auto result = engine.execute_prerequest ("var JEFE = '" +
    std::string (JEFE_MESSAGE) + "'; pm.environment.set('out', String(" + expression + "));",
    request, env);
    return result.success ? env["out"].value : "threw: " + result.error_message;
}

} // namespace vayu::tests
