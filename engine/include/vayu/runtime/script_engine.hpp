#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

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
    size_t stack_size   = vayu::core::constants::script_engine::STACK_SIZE;
    bool enable_console = vayu::core::constants::script_engine::ENABLE_CONSOLE;
};

/**
 * @brief Script execution context with request/response data
 */
struct ScriptContext {
    const Request* request           = nullptr;
    const Response* response         = nullptr;
    Environment* environment         = nullptr;
    Environment* globals             = nullptr;
    Environment* collectionVariables = nullptr;

    /**
     * @brief Where the script's `pm.request` edits land, or null to discard them.
     *
     * Set only for pre-request scripts, and only through
     * `make_request_mutable()` - it must be the same object `request` points
     * at, so the script writes back to the snapshot it was shown. A test script
     * leaves it null: its request has already gone out, so a mutation there
     * could only misreport what was sent.
     */
    Request* mutable_request = nullptr;

    /**
     * @brief Expose @p req to the script as a mutable `pm.request`.
     *
     * The one supported way to opt into write-back, so the read snapshot and
     * the write target cannot drift apart.
     */
    void make_request_mutable (Request& req) {
        request         = &req;
        mutable_request = &req;
    }
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
    explicit ScriptEngine (const ScriptConfig& config = {});

    /**
     * @brief Destructor - cleans up QuickJS runtime
     */
    ~ScriptEngine ();

    // Non-copyable, movable
    ScriptEngine (const ScriptEngine&)            = delete;
    ScriptEngine& operator= (const ScriptEngine&) = delete;
    ScriptEngine (ScriptEngine&&) noexcept;
    ScriptEngine& operator= (ScriptEngine&&) noexcept;

    /**
     * @brief Execute a script
     * @param script JavaScript code to execute
     * @param ctx Context with request/response data
     * @return Script execution result with test results
     */
    [[nodiscard]] ScriptResult execute (const std::string& script, const ScriptContext& ctx);

    /**
     * @brief Execute a pre-request script
     *
     * The script sees the fully composed request - auth is already resolved
     * into its headers and URL by the time it runs - and whatever it leaves in
     * `pm.request` when it returns is written back into @p request before the
     * send. A script-set header therefore overrides an engine-applied one of
     * the same name.
     *
     * @param script JavaScript code
     * @param request Request the script may modify through `pm.request`
     * @param env Environment variables
     * @return Script result; unsuccessful if the script threw or its
     *         `pm.request` edits were rejected (see `ScriptResult::error_message`)
     */
    [[nodiscard]] ScriptResult
    execute_prerequest (const std::string& script, Request& request, Environment& env);

    /**
     * @brief Execute a test script
     * @param script JavaScript code with pm.test() calls
     * @param request The sent request
     * @param response The received response
     * @param env Environment variables
     * @return Script result with test outcomes
     */
    [[nodiscard]] ScriptResult execute_test (const std::string& script,
    const Request& request,
    const Response& response,
    Environment& env);

    /**
     * @brief Check if scripting is available
     * @return true if QuickJS is compiled in
     */
    [[nodiscard]] static bool is_available ();

    /**
     * @brief Get QuickJS version string
     * @return Version string or empty if not available
     */
    [[nodiscard]] static std::string version ();

    private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace vayu::runtime
