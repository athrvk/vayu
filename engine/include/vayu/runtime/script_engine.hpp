#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief JavaScript scripting engine using QuickJS
 *
 * Provides Postman-compatible scripting with pm.test(), pm.expect(),
 * and access to request/response data.
 */

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/custom_metric_type.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::runtime {

struct ScriptConfig {
    size_t memory_limit = vayu::core::constants::script_engine::MEMORY_LIMIT;
    uint64_t timeout_ms = vayu::core::constants::script_engine::TIMEOUT_MS;
    size_t stack_size   = vayu::core::constants::script_engine::STACK_SIZE;
    bool enable_console = vayu::core::constants::script_engine::ENABLE_CONSOLE;

    /**
     * @brief Whether scripts may issue requests through `pm.sendRequest`.
     *
     * **Defaults to false, and that default is the security control** (#302).
     * The MCP target allowlist is enforced client-side, in the MCP server,
     * against the composed URL before it calls `POST /execute`; a request
     * issued from inside a script never passes that gate, so an agent that can
     * write a script would otherwise reach any host, defeating a control the
     * user configured in Settings.
     *
     * Denying by default puts the failure on the safe side: a client that
     * forgets to ask (a new MCP tool, a future caller, a bare `curl` against
     * the daemon) gets a script that cannot send, not silent egress. The app's
     * own execute/run paths ask for it explicitly, as they send
     * `followRedirects` rather than lean on an engine default.
     *
     * `pm.sendRequest` is bound either way: when this is false it throws a
     * message naming why, a better answer than a missing global.
     */
    bool allow_send_request = false;

    /**
     * @brief Whether each `pm.sendRequest` leaves a record on
     *        `ScriptResult::script_requests` (#3633): the exchange in the
     *        trace's own shape, its credentials masked.
     *
     * Off by default, and turned on only by the two callers that store a trace
     * per send (`vayu::core::record_script_requests`): a design send and a
     * sequential collection run. A load run stores no trace per request, so its
     * scripts build none; their summary line is gated by `enable_console`
     * alone, which this does not read.
     */
    bool record_send_requests = false;

    /**
     * @brief What one execution's records' bodies may hold between them,
     *        `maxTraceBodyBytes`; read only when @ref record_send_requests is.
     *        A body past what is left is cut, with its `bodyTruncated` /
     *        `bodyBytes` pair.
     */
    size_t max_trace_body_bytes = vayu::core::constants::json::MAX_TRACE_BODY_BYTES;
};

/**
 * @brief Which hook a script is running as, reported to it as `pm.info.eventName`.
 */
enum class ScriptEvent : std::uint8_t {
    PreRequest,
    Test,
    Setup,
    Teardown,
};

/**
 * @brief `pm.info.run` - what a `script.teardown` script reads about the run
 *        it is cleaning up after (#1499). Set only on a teardown context;
 *        absent everywhere else, including `script.setup`'s own context,
 *        which runs before any of these figures exist.
 */
struct RunSummaryInfo {
    size_t requests_sent     = 0;
    double error_rate        = 0.0;
    size_t assertions_passed = 0;
    size_t assertions_failed = 0;
};

struct ScriptContext {
    const Request* request           = nullptr;
    const Response* response         = nullptr;
    Environment* environment         = nullptr;
    Environment* globals             = nullptr;
    Environment* collectionVariables = nullptr;

    /**
     * @brief The collection scopes above `collectionVariables`, root first.
     *
     * The request's collection ancestors (`collection_chain` without its leaf),
     * so a script reads a name an ancestor collection defines exactly as
     * `{{name}}` in the URL does (#234). Reads walk leaf to root and take the
     * nearest enabled definition; `set`, `unset` and `clear` touch
     * `collectionVariables` alone, so the leaf shadows an ancestor but can
     * never delete it.
     *
     * The `const` is the design, not politeness: `persist_script_variables`
     * writes every name the leaf's map holds that it did not hold when loaded,
     * so an ancestor merged into it would let one `set()` copy every inherited
     * variable down into the leaf collection permanently.
     */
    const std::vector<Environment>* collectionAncestors = nullptr;

    /**
     * @brief The run-local scope `pm.variables.set` writes (#2564).
     *
     * `ScriptVariableScopes::local`, bound by `bind_variable_scopes`, so it
     * lives as long as the run that owns it. Null gives the script a scope of
     * its own that ends with it, rather than a set that reports success and
     * lands nowhere.
     */
    Environment* local = nullptr;

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
     * All three are optional because absence is the honest answer for each: an
     * ad-hoc request has no id, an unsaved one may have a name no row carries,
     * and a context built by hand (a test, a future caller) has declared no
     * hook. A field with no value reaches the script as `undefined`, not `""`,
     * so `typeof pm.info.requestName` answers what a Postman user expects.
     *
     * `event` is never assigned by a caller: the two factories below set it, so
     * `pm.info.eventName` cannot disagree with the hook that is running.
     *
     * `iteration` / `vu` are set **only where the executor claimed one before
     * the send**, which keeps #300's ruling: it refuses reporting a *reservoir
     * position* as an iteration number, a binding that cannot fail. A load
     * run's deferred `tests` script runs once per sampled response, and each
     * sample carries the iteration and virtual user it was sent as (#994),
     * facts claimed on the submission path, so reporting them is honest. An
     * ordinary Send reads `undefined` for both; a `POST /execute` naming a
     * `data` row reports iteration 0 of 1 (#601).
     *
     * `iterationCount` is narrower than either: a duration-bounded run has no
     * total to report, and a field readable in one mode and not another is
     * worse than one never readable. The collection runner sets it, and so does
     * the `data` row send above: `1`, the total that send's row 0 of 1 belongs
     * to.
     *
     * `iteration` is 0-based (Postman's convention); `vu` is 1-based, because
     * it names a user rather than indexing anything; `iterationCount` is the
     * total the run will perform.
     */
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    std::optional<ScriptEvent> event;
    std::optional<size_t> iteration;
    std::optional<size_t> vu;
    std::optional<size_t> iteration_count;
    /// `pm.info.run`, set only by `for_teardown` (#1499).
    std::optional<RunSummaryInfo> run_summary;

    /**
     * @brief The data row this iteration is bound to, read as
     *        `pm.iterationData`, or null where the run has no data (#356).
     *
     * Points into the run's `ScenarioExecution::data_rows`, which outlives
     * every script of the run, or, for a `POST /execute` naming a `data` row
     * (#601), into the row the handler read off that payload. Always a JSON
     * object: anything else is a `400` before the run row exists.
     *
     * Null is the ordinary case and reaches the script as **`undefined`**, not
     * as an empty scope answering `undefined` to every key. That is not the
     * `pm.execution` / `pm.cookies` treatment: those are capabilities, and a
     * capability that silently does nothing is #188's false success. This is
     * *data*, and "this run has no data" is a fact a script may branch on:
     * `if (pm.iterationData)` is the guard, and it works only if absence is
     * visible. A `POST /execute` send carrying no `data` row and a load run's
     * deferred `tests` script therefore see `undefined`, as they do for
     * `pm.info.iteration`.
     */
    const nlohmann::json* iteration_data = nullptr;

    /**
     * @brief The completed stream's events, read as `pm.response.events`, or
     *        null where the run was not a stream (#575).
     *
     * An `events` node: `items`, `totalEvents` and `eventsTruncated`. A design
     * stream points at one `vayu::http::stream_events_node` built from its body
     * and the sidecar its trace stores, the builder every reader of that trace
     * applies (#3770); every buffered stream (a collection run's step, a load
     * run's inline or replayed script) points at one
     * `vayu::http::bind_buffered_stream_events` built from the body with the
     * function its stored trace or sample is built with (#3769). Either way the
     * markers come from the stored node's own builder, not a second cap applied
     * here, so a script that refuses to assert over a partial list and a reader
     * of the stored record never disagree about whether the list is partial.
     *
     * Null is the ordinary case and reaches the script as an **absent**
     * `pm.response.events`, not an empty array, for `iteration_data`'s reason:
     * "this response was not a stream" is a fact a script may branch on, and an
     * empty array would make it indistinguishable from a stream that produced
     * nothing.
     *
     * Only a post-request script over a streamed response sets it: it runs
     * once, after the stream has terminated, over the bounded stored list.
     * There is no live per-event callback because the transfer has ended before
     * any script runs.
     */
    const nlohmann::json* response_events = nullptr;

    /**
     * @brief The redirect hops `response` was reached through, read as
     *        `pm.response.redirects`, or null where the producer does not
     *        record them (#2949).
     *
     * Points at `Response::redirect_hops`, which only `Client::send` fills. The
     * load path follows redirects without recording the chain, so a deferred
     * `tests` script and a streamed run's script get null - an **absent**
     * `pm.response.redirects`, not an empty array: `[]` there would read as
     * "nothing was redirected", a claim no one measured. A non-null pointer to
     * an empty vector is the recorded "no redirect".
     */
    const std::vector<RedirectHop>* redirect_hops = nullptr;

    /**
     * @brief Whether this script runs inside an ordered sequence, and may
     *        therefore redirect it (#355).
     *
     * Set by the scenario runner and by nothing else. With it false (a
     * `POST /execute` send, a load run's deferred `tests` script, a context
     * built by hand), `pm.execution.setNextRequest` and
     * `pm.execution.skipRequest` throw a sentence naming why rather than accept
     * a call and do nothing.
     *
     * That is #188's standing rule: `setNextRequest("checkout")` silently
     * ignored in a single send is the false success it exists to prevent. It
     * also keeps the load path honest: a deferred script has run against a
     * recorded response and cannot redirect a sequence that already happened.
     */
    bool in_scenario = false;

    /**
     * @brief The jar `pm.cookies` reads and `pm.sendRequest` sends through, or
     *        null where there is no jar (#301).
     *
     * Null is not "an empty jar": a load run's test scripts have no jar at all
     * (cookie_jar.hpp says why the load path stays out of it), and neither does
     * a context built by hand. `pm.cookies` throws a sentence saying so rather
     * than answer `undefined` for every name: a binding that cannot fail is
     * worse than a missing one, and "the cookie you set is not here" would send
     * someone hunting the wrong bug.
     *
     * `pm.sendRequest` **shares** it, deliberately: the flow the jar exists for
     * is "log in with sendRequest in a pre-request script, then let the real
     * request carry the session", which an isolated auxiliary jar would break.
     * A cookie the auxiliary request collects is therefore visible to the main
     * one, and to the next request in the same environment.
     */
    vayu::http::CookieJar* cookie_jar = nullptr;

    /// Which jar - the environment id, or `NO_ENVIRONMENT_SCOPE`. Read only
    /// when `cookie_jar` is set.
    std::string cookie_scope{ vayu::http::NO_ENVIRONMENT_SCOPE };

    /**
     * @brief Where `pm.cookies.jar()`'s writes are staged, or null to refuse
     *        them (#337).
     *
     * The caller owns the vector for the same reason it owns `environment`: the
     * write has to outlive the script and be applied where the ordering is
     * known - by the transfer that follows (`ClientConfig::cookie_writes`), or
     * by the route through `CookieJar::apply` when no transfer follows. See
     * cookie_jar.hpp for why a script cannot simply write into the map.
     *
     * Null is refused loudly rather than silently dropped: a context that never
     * applies what a script wrote would report success for a cookie that went
     * nowhere.
     */
    std::vector<vayu::http::CookieWrite>* cookie_writes = nullptr;

    /**
     * @brief A read-only view of the cookies one virtual user carries into this
     *        step of a scenario load run, or null (#1501).
     *
     * Set only by the inline `step.before`/`step.after` hooks a scenario load
     * run's own producer and completion callbacks run for a `script.*` element
     * marked to run inline (#1495): `scenario_load.cpp` points it at
     * `VirtualUser::cookies`, lines already materialized on the VU with that
     * VU's own completion the only reader, so no lock and no `CookieJar` object
     * are needed. `pm.cookies`'s flat reads answer from this when `cookie_jar`
     * is null; `pm.cookies.jar()` (staging a *write*) stays gated on
     * `cookie_jar` alone, because a load run's cookie state advances through
     * `VirtualUser::cookies` itself, never through a script.
     */
    const std::vector<std::string>* cookie_read_lines = nullptr;

    /**
     * @brief What a flat `pm.cookies` read throws when neither `cookie_jar` nor
     *        `cookie_read_lines` is set, or null for the default
     *        design-mode-feature sentence (#1501).
     *
     * Two load-path contexts have a truer thing to say than the default: a
     * deferred script replay runs after the run, against a recorded sample
     * whose per-user cookie view is gone; a single-request load run never had
     * one, having no scenario and no virtual user. `%s` is the member name,
     * exactly as the default message takes it.
     */
    const char* cookie_read_refusal = nullptr;

    /**
     * @brief How `pm.sendRequest` reaches the network (#705).
     *
     * The same policy the enclosing exchange's own send uses, for the same
     * reason the jar is shared: a script that logs in through `sendRequest` and
     * then lets the real request carry the session must take the same route out
     * of the machine, or one of the two is unreachable behind a corporate
     * proxy. A context built by hand keeps the default, the environment pickup.
     */
    vayu::http::TransportPolicy transport;

    /**
     * @brief What the engine adds to a `pm.sendRequest` the script did not
     *        write itself (#1229).
     *
     * The same set the enclosing exchange's own send adds, carried in for the
     * reason `transport` is: the script engine holds no `Database`, and a
     * script's auxiliary send is still a send Vayu made. A context built by
     * hand keeps the built-in default, the `User-Agent` alone.
     */
    vayu::http::DefaultHeaderPolicy default_headers;

    /**
     * @brief How much of a `pm.sendRequest` response body the engine will read
     *        before refusing the transfer (#1188).
     *
     * Carried in for `transport`'s reason: the script engine holds no
     * `Database`, and the caller has already resolved the bound its own send
     * reads. The bound differs by path, deliberately: a design-mode send's
     * scripts take `maxDesignResponseBodyBytes`; every script of a load run
     * (the deferred `tests` replay, an inline step script, `script.setup` and
     * `script.teardown`) takes `maxResponseBodyBytes`, because a script that
     * runs once per submission or per sampled response belongs to the load
     * path's memory budget, not to the one sized for a body a person is about
     * to look at. A run's scripts outside an exchange (a load run's, a
     * collection run's `script.setup` and `script.teardown`) get this field
     * with the rest of one `ScriptSendInputs` (#2841).
     *
     * Reaching it **refuses** the transfer (`ErrorCode::ResponseTooLarge`
     * reaches the callback as its `err`) rather than hand the script a prefix:
     * neither `pm.sendRequest`'s response object nor `pm.response` exposes a
     * truncation flag, so a cut body would reach `JSON.parse` as corrupt input
     * with nothing to say why. `/import/fetch` refuses for the same reason.
     *
     * The default is the compiled-in design bound, not `0`, so a context built
     * by hand is bounded by construction; `0` would be unbounded, the state
     * #1188 exists to end.
     */
    size_t max_response_bytes = vayu::core::constants::http::MAX_DESIGN_RESPONSE_BODY_BYTES;

    /**
     * @brief The timeout a `pm.sendRequest` takes when its options name none
     *        (#2833): the enclosing exchange's or run's resolved request
     *        timeout, the payload's `timeout` else the `defaultTimeout`
     *        setting.
     *
     * Carried in for the reason @ref max_response_bytes is. The script's own
     * `timeout` option replaces it, and the script's remaining budget can only
     * lower whichever applies. The default is the compiled-in one, so a context
     * built by hand is bounded by construction.
     */
    int request_timeout_ms = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;

    /**
     * @brief `ClientConfig::cancel` for every `pm.sendRequest` this script
     *        makes (#2683), or null when nothing ends one early.
     *
     * The enclosing exchange's own (`ExchangeInputs::cancel`), so a script send
     * inside `POST /execute` ends with the server the way the request's own
     * send does; in a run, the run's `should_stop`, through
     * @ref ScriptSendInputs (#3371). A send it ends sets
     * `ScriptResult::send_cancelled`.
     */
    const std::atomic<bool>* cancel = nullptr;

    /**
     * @brief Ends the script itself when raised (#3460), or null when
     *        nothing may.
     *
     * The interrupt handler reads it at every poll beside the deadline, and
     * the async drain before every job and timer, so a script stops within a
     * poll of it rising; the result is `ScriptResult::cancelled`, no verdict.
     * A run's scripts take the run's `should_stop` through
     * @ref ScriptSendInputs or `ExchangeInputs::stop`. Separate from
     * @ref cancel because some scripts must still run after the flag that
     * cancels their sends: a `POST /execute`'s (its post-request script runs
     * after a stream's Stop) and a teardown a Stop was latched before
     * (`RunContext::teardown_stop`).
     */
    const std::atomic<bool>* stop = nullptr;

    /**
     * @brief `pm.metrics`'s write destination (#1500), or null to refuse it.
     *
     * Null is the ordinary case for a context built by hand and for the
     * deferred `tests` replay - a replayed sample is not the run, the same "not
     * available here" reasoning `in_scenario` documents for `pm.execution`.
     * Bound by the scenario runner and by the load path's inline `step.before`
     * / `step.after` hooks (`scenario_load.cpp`), both to the run's own
     * `MetricsCollector::record_custom_metric`.
     */
    std::function<void (const std::string& name, vayu::core::CustomMetricType type, double value)> record_metric;

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

    /**
     * @brief A `script.setup` context: no request or response of its own -
     *        it runs once, at the run's own boundary, before any step has.
     */
    [[nodiscard]] static ScriptContext for_setup () {
        ScriptContext ctx;
        ctx.event = ScriptEvent::Setup;
        return ctx;
    }

    /**
     * @brief A `script.teardown` context, carrying @p summary as `pm.info.run`:
     *        the one context that can report a run summary, because it is
     *        the one that runs after there is one.
     */
    [[nodiscard]] static ScriptContext for_teardown (const RunSummaryInfo& summary) {
        ScriptContext ctx;
        ctx.event       = ScriptEvent::Teardown;
        ctx.run_summary = summary;
        return ctx;
    }
};

/**
 * @brief What a `pm.sendRequest` inherits from the run it runs inside (#2841):
 *        the `ScriptContext` fields a script cannot set for itself, resolved
 *        once by the run and applied together.
 *
 * One value rather than an assignment per field per call site, because a site
 * that leaves one out sends with the compiled-in default for it: a script that
 * waits 30 s on a run whose `timeout` is 500 ms, leaves by another route than
 * the run's own transfers, or holds Stop and shutdown open for its whole
 * timeout (#3371).
 *
 * Default-constructed it holds a fresh `ScriptContext`'s own values, so
 * applying one changes nothing; a `RunContext` built by hand keeps the
 * compiled-in bounds and no cancel.
 */
struct ScriptSendInputs {
    /// `ScriptContext::transport`.
    vayu::http::TransportPolicy transport;
    /// `ScriptContext::default_headers`.
    vayu::http::DefaultHeaderPolicy default_headers;
    /// `ScriptContext::max_response_bytes`.
    size_t max_response_bytes = vayu::core::constants::http::MAX_DESIGN_RESPONSE_BODY_BYTES;
    /// `ScriptContext::request_timeout_ms`.
    int request_timeout_ms = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
    /// `ScriptContext::cancel`: the run's `should_stop`, which Stop and
    /// shutdown both raise. Must outlive every script it is applied to.
    const std::atomic<bool>* cancel = nullptr;
    /// `ScriptContext::stop`: the run's `should_stop` too, except for a
    /// teardown (`RunContext::teardown_stop`). Must outlive every script it is
    /// applied to.
    const std::atomic<bool>* stop = nullptr;

    void apply (ScriptContext& ctx) const {
        ctx.transport          = transport;
        ctx.default_headers    = default_headers;
        ctx.max_response_bytes = max_response_bytes;
        ctx.request_timeout_ms = request_timeout_ms;
        ctx.cancel             = cancel;
        ctx.stop               = stop;
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

    ~ScriptEngine ();

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
     * The script sees the composed request - auth is already resolved into its
     * headers and URL by the time it runs, unless a credential waits on this
     * script (`apply_late_auth`), and every `{{name}}` composition deferred
     * past it (#2521) is still written - and whatever it leaves in
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

    /**
     * @brief How many runtimes this engine's pool holds idle.
     *
     * An execution returns its runtime to the pool unless it ended with a
     * promise job still queued, when the runtime is discarded instead (#1823);
     * this is how a test tells the two apart.
     */
    [[nodiscard]] size_t idle_runtime_count () const;

    /**
     * @brief How many times this process has evaluated the source of a
     *        library `require()` loads (#2578).
     *
     * A library is evaluated on its first use in an execution and never when
     * a context is built, which every script pays for; this is how a test
     * tells the two apart.
     */
    [[nodiscard]] static size_t shelf_library_loads ();

    private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace vayu::runtime
