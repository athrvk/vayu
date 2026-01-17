#pragma once

/**
 * @file script_engine.hpp
 * @brief JavaScript scripting engine using QuickJS
 *
 * Provides Postman-compatible scripting with pm.test(), pm.expect(),
 * and access to request/response data.
 */

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/types.hpp"

namespace vayu::runtime {

/**
 * @brief Configuration for script execution
 */
struct ScriptConfig {
    size_t memory_limit = vayu::core::constants::script_engine::MEMORY_LIMIT;
    uint64_t timeout_ms = vayu::core::constants::script_engine::TIMEOUT_MS;
    size_t stack_size = vayu::core::constants::script_engine::STACK_SIZE;
    bool enable_console = vayu::core::constants::script_engine::ENABLE_CONSOLE;
};

/**
 * @brief Script execution context with request/response data
 */
struct ScriptContext {
    const Request* request = nullptr;
    const Response* response = nullptr;
    Environment* environment = nullptr;
    Environment* globals = nullptr;
    Environment* collectionVariables = nullptr;
};

/**
 * @brief JavaScript scripting engine
 *
 * Executes pre-request and test scripts with access to request/response
 * data through Postman-compatible `pm` object.
 *
 * Example script:
 * @code
 * pm.test("Status is 200", function() {
 *     pm.expect(pm.response.code).to.equal(200);
 * });
 *
 * pm.test("Body contains user", function() {
 *     var json = pm.response.json();
 *     pm.expect(json.name).to.exist;
 * });
 * @endcode
 */
class ScriptEngine {
public:
    /**
     * @brief Construct a new Script Engine
     * @param config Configuration options
     */
    explicit ScriptEngine(const ScriptConfig& config = {});

    /**
     * @brief Destructor - cleans up QuickJS runtime
     */
    ~ScriptEngine();

    // Non-copyable, movable
    ScriptEngine(const ScriptEngine&) = delete;
    ScriptEngine& operator=(const ScriptEngine&) = delete;
    ScriptEngine(ScriptEngine&&) noexcept;
    ScriptEngine& operator=(ScriptEngine&&) noexcept;

    /**
     * @brief Execute a script
     * @param script JavaScript code to execute
     * @param ctx Context with request/response data
     * @return Script execution result with test results
     */
    [[nodiscard]] ScriptResult execute(const std::string& script, const ScriptContext& ctx);

    /**
     * @brief Execute a pre-request script
     * @param script JavaScript code
     * @param request Request to potentially modify
     * @param env Environment variables
     * @return Script result
     */
    [[nodiscard]] ScriptResult execute_prerequest(const std::string& script,
                                                  Request& request,
                                                  Environment& env);

    /**
     * @brief Execute a test script
     * @param script JavaScript code with pm.test() calls
     * @param request The sent request
     * @param response The received response
     * @param env Environment variables
     * @return Script result with test outcomes
     */
    [[nodiscard]] ScriptResult execute_test(const std::string& script,
                                            const Request& request,
                                            const Response& response,
                                            Environment& env);

    /**
     * @brief Check if scripting is available
     * @return true if QuickJS is compiled in
     */
    [[nodiscard]] static bool is_available();

    /**
     * @brief Get QuickJS version string
     * @return Version string or empty if not available
     */
    [[nodiscard]] static std::string version();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace vayu::runtime
