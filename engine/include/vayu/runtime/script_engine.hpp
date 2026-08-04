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
#include <optional>
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
 * @brief Which hook a script is running as, reported to it as `pm.info.eventName`.
 */
enum class ScriptEvent {
    PreRequest,
    Test,
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
     * @brief The collection scopes above `collectionVariables`, root first.
     *
     * The request's collection ancestors - `collection_chain` without its leaf
     * - so a script reads a name an ancestor collection defines exactly as
     * `{{name}}` in the URL does (issue #234). Collection reads walk leaf ->
     * root and take the nearest enabled definition; `set`, `unset` and `clear`
     * still touch `collectionVariables` alone, so the leaf shadows an ancestor
     * but can never delete it.
     *
     * The `const` is the design rather than politeness:
     * `persist_script_variables` writes a scope back by diffing it against the
     * leaf collection's stored blob, so a writable ancestor would let one
     * `set()` copy every inherited variable down into the leaf collection
     * permanently. Ancestors that cannot be written cannot be copied down.
     */
    const std::vector<Environment>* collectionAncestors = nullptr;

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
     * @brief What the script reads as `pm.info` - identity, not data.
     *
     * All three are optional because absence is the honest answer for each:
     * an ad-hoc request has no id, an unsaved one may have a name no row
     * carries, and a context built by hand (a test, a future caller) has
     * declared no hook. A field with no value must reach the script as
     * `undefined` rather than `""`, so `typeof pm.info.requestName` answers
     * what a Postman user expects.
     *
     * `event` is never assigned by a caller: it is set by the two factories
     * below, so `pm.info.eventName` cannot disagree with the hook that is
     * actually running.
     *
     * There is deliberately no `iteration` / `iterationCount` here. Vayu runs
     * a load test's `tests` script once per *sampled* response after the run
     * has finished, not once per iteration, and a reservoir sample index
     * reported as an iteration number would be a binding that cannot fail -
     * worse than a missing one (issue #300).
     */
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    std::optional<ScriptEvent> event;

    /**
     * @brief Expose @p req to the script as a mutable `pm.request`.
     *
     * The one supported way to opt into write-back, so the read snapshot and
     * the write target cannot drift apart. Write-back is a pre-request-only
     * affordance, so this is also what stamps the hook.
     */
    void make_request_mutable (Request& req) {
        request         = &req;
        mutable_request = &req;
        event           = ScriptEvent::PreRequest;
    }

    /**
     * @brief A pre-request context: @p req is both what the script reads and
     *        where its `pm.request` edits land.
     */
    [[nodiscard]] static ScriptContext for_prerequest (Request& req) {
        ScriptContext ctx;
        ctx.make_request_mutable (req);
        return ctx;
    }

    /**
     * @brief A test context: @p req has already gone out, so nothing is
     *        written back - a mutation here could only misreport what was sent.
     */
    [[nodiscard]] static ScriptContext for_test (const Request& req, const Response& res) {
        ScriptContext ctx;
        ctx.request  = &req;
        ctx.response = &res;
        ctx.event    = ScriptEvent::Test;
        return ctx;
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
