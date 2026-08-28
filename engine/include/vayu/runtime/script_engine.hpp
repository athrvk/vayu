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

#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/transport_policy.hpp"
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

    /**
     * @brief Whether scripts may issue requests through `pm.sendRequest`.
     *
     * **Defaults to false, and that default is the security control** (issue
     * #302). The MCP target allowlist is enforced client-side, in the MCP
     * server, against the composed URL before it calls `POST /execute` - a
     * request issued from inside a script never passes that gate, because it
     * never goes through the MCP server at all. So an agent that can write a
     * script would otherwise reach any host, defeating a control the user
     * configured in Settings.
     *
     * Denying by default puts the failure on the safe side: a client that
     * forgets to ask - a new MCP tool, a future caller, a bare `curl` against
     * the daemon - gets a script that cannot send, not silent egress. The
     * app's own execute/run paths ask for it explicitly, exactly the way they
     * send `followRedirects` rather than leaning on an engine default.
     *
     * `pm.sendRequest` is bound either way: when this is false it throws a
     * message that names why, which is a better answer than a missing global.
     */
    bool allow_send_request = false;
};

/**
 * @brief Which hook a script is running as, reported to it as `pm.info.eventName`.
 */
enum class ScriptEvent : std::uint8_t {
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
     * `iteration` / `vu` are set **only where the executor claimed one before
     * the send**, which is what keeps issue #300's ruling intact rather than
     * reopening it: what that ruling refuses is reporting a *reservoir
     * position* as an iteration number, a binding that cannot fail. A load
     * run's deferred `tests` script runs once per sampled response, and since
     * issue #994 each sample carries the iteration and the virtual user it was
     * actually sent as - facts claimed on the submission path - so reporting
     * them is honest rather than invented. An ordinary Send reads `undefined`
     * for both, as it always did; a `POST /execute` naming a `data` row reports
     * iteration 0 of 1 (issue #601).
     *
     * `iterationCount` stays narrower than either: a duration-bounded run has
     * no total to report, and a field readable from one mode and not another is
     * worse than one that is never readable at all. The collection runner sets
     * it, and so does the `data` row send above - `1`, the total that send's
     * row 0 of 1 belongs to.
     *
     * `iteration` is 0-based (Postman's convention); `vu` is 1-based, because
     * it is a name for a user rather than an index into anything;
     * `iterationCount` is the total the run will perform.
     */
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    std::optional<ScriptEvent> event;
    std::optional<size_t> iteration;
    std::optional<size_t> vu;
    std::optional<size_t> iteration_count;

    /**
     * @brief The data row this iteration is bound to, read as
     *        `pm.iterationData`, or null where the run has no data (issue
     *        #356).
     *
     * Points into the run's `ScenarioExecution::data_rows`, which outlives
     * every script of the run - or, for a `POST /execute` naming a `data` row
     * (issue #601), into the row the handler read off that payload. The object
     * is always a JSON object, because anything else is a `400` before the run
     * row exists.
     *
     * Null is the ordinary case and reaches the script as **`undefined`**
     * rather than as an empty scope that answers `undefined` to every key.
     * That is deliberate, and it is not the `pm.execution` / `pm.cookies`
     * treatment: those are capabilities, and a capability that silently does
     * nothing is #188's false success. This is *data*, and "this run has no
     * data" is a fact a script may legitimately branch on -
     * `if (pm.iterationData)` is the guard, and it can only work if absence is
     * visible. A `POST /execute` send carrying no `data` row and a load run's
     * deferred `tests` script therefore see `undefined`, as they do for
     * `pm.info.iteration`.
     */
    const nlohmann::json* iteration_data = nullptr;

    /**
     * @brief The completed stream's events, read as `pm.response.events`, or
     *        null where the run was not a stream (issue #575).
     *
     * Points at the very `events` node the run's trace stores
     * (`vayu::http::stream_trace_node`): `items`, `totalEvents` and
     * `eventsTruncated`. Sharing the node rather than copying it out is what
     * makes "the markers a script reads mirror the markers the trace records"
     * true by construction instead of by a second cap applied here - a script
     * that refuses to assert over a partial list and a reader looking at the
     * stored trace must never disagree about whether the list is partial.
     *
     * Null is the ordinary case and reaches the script as an **absent**
     * `pm.response.events`, not an empty array - the same rule
     * `iteration_data` follows, for the same reason: "this response was not a
     * stream" is a fact a script may branch on, and an empty array would make
     * it indistinguishable from a stream that produced nothing.
     *
     * A streaming run's post-request script is the only caller that sets it:
     * it runs once, after the stream has terminated, over the bounded stored
     * list. The sandbox is synchronous with no event loop (see
     * `ABSENT_GLOBALS` in script_types.cpp), so a live per-event callback is
     * not a feature that was skipped - it is one the runtime cannot have.
     */
    const nlohmann::json* response_events = nullptr;

    /**
     * @brief Whether this script runs inside an ordered sequence, and may
     *        therefore redirect it (issue #355).
     *
     * Set by the scenario runner and by nothing else. With it false -
     * a `POST /execute` send, a load run's deferred `tests` script, a context
     * built by hand - `pm.execution.setNextRequest` and
     * `pm.execution.skipRequest` throw a sentence naming why, rather than
     * accepting a call and doing nothing.
     *
     * That is issue #188's standing rule, not caution:
     * `setNextRequest("checkout")` silently ignored in a single send is exactly
     * the false success it exists to prevent. It is also what keeps the load
     * path honest - a deferred script has already run against a recorded
     * response and cannot redirect a sequence that already happened.
     */
    bool in_scenario = false;

    /**
     * @brief The jar `pm.cookies` reads and `pm.sendRequest` sends through,
     *        or null where there is no jar (issue #301).
     *
     * Null is not "an empty jar": a load run's test scripts have no jar at all
     * (see cookie_jar.hpp for why the load path stays out of it), and so does
     * a context built by hand. `pm.cookies` throws a sentence saying so rather
     * than answering `undefined` for every name - a binding that cannot fail
     * is worse than a missing one, and "the cookie you set is not here" is
     * exactly the answer that would send someone hunting the wrong bug.
     *
     * `pm.sendRequest` **shares** it, deliberately: the flow the jar exists
     * for is "log in with sendRequest in a pre-request script, then let the
     * real request carry the session", which an isolated auxiliary jar would
     * break. A cookie the auxiliary request collects is therefore visible to
     * the main one, and to the next request in the same environment.
     */
    vayu::http::CookieJar* cookie_jar = nullptr;

    /// Which jar - the environment id, or `NO_ENVIRONMENT_SCOPE`. Read only
    /// when `cookie_jar` is set.
    std::string cookie_scope{ vayu::http::NO_ENVIRONMENT_SCOPE };

    /**
     * @brief Where `pm.cookies.jar()`'s writes are staged, or null to refuse
     *        them (issue #337).
     *
     * The caller owns the vector for the same reason it owns `environment`:
     * the write has to outlive the script and be applied where the ordering is
     * known - by the transfer that follows (`ClientConfig::cookie_writes`), or
     * by the route through `CookieJar::apply` when no transfer follows. See
     * cookie_jar.hpp for why a script cannot simply write into the map.
     *
     * Null is refused loudly rather than silently dropped: a context that
     * never applies what a script wrote would report success for a cookie that
     * went nowhere.
     */
    std::vector<vayu::http::CookieWrite>* cookie_writes = nullptr;

    /**
     * @brief How `pm.sendRequest` reaches the network (issue #705).
     *
     * The same policy the enclosing exchange's own send uses, for the same
     * reason the jar is shared: a script that logs in through `sendRequest`
     * and then lets the real request carry the session must take the same
     * route out of the machine, or one of the two is unreachable behind a
     * corporate proxy. A context built by hand keeps the default (the
     * environment pickup), which is what every script send did before the
     * policy existed.
     */
    vayu::http::TransportPolicy transport;

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
