#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/request_exchange.hpp
 * @brief One design-mode exchange - pre-request script, send, test script -
 *        extracted from the `POST /execute` handler so the scenario runner
 *        executes the same body rather than a copy of it.
 *
 * The route still owns everything that is the route's: parsing the payload,
 * creating the run row, deciding what to persist and what to answer with. What
 * lives here is the part a scenario step and a single Send have to perform
 * identically - the script/send/script ordering, the write-back that lets a
 * pre-request script change what goes on the wire, and the cookie-write
 * discipline that applies each script's jar writes exactly once.
 *
 * It lives in `vayu_core` (not with the route sources) because the runner is a
 * core component: a copy of this sequence in the runner would be a copy that
 * never receives this one's fixes.
 */

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {

/**
 * The variable scopes a design run hands its pre/post-request scripts.
 *
 * `collection` is the request's immediate parent - the only collection scope a
 * script may write, and the one `persist_script_variables` writes back.
 * `collection_ancestors` is the rest of that collection's chain, root first,
 * which scripts read through but cannot modify (issue #234).
 */
struct ScriptVariableScopes {
    vayu::Environment environment;
    vayu::Environment globals;
    vayu::Environment collection;
    std::vector<vayu::Environment> collection_ancestors;
};

/**
 * Load those scopes for @p run. The collection chain is the same walk
 * `{{variable}}` composition uses, so a script and a request field resolve an
 * inherited name identically; a run with no environment, no request or a
 * request outside any collection simply yields empty scopes.
 *
 * Extracted from the `POST /execute` handler (execution.cpp) so
 * script_variables_test.cpp can drive it against a real database, matching the
 * suite's other route-core tests.
 */
ScriptVariableScopes
load_script_variable_scopes (vayu::db::Database& db, const vayu::db::Run& run);

/**
 * The same scopes named directly, for a run whose collection scope does not
 * come from a single request row.
 *
 * A scenario run is exactly that case: it executes a whole collection, so the
 * scope its scripts read and write is the collection being run, not the
 * collection of some request the row happens to link. Pass an empty
 * @p collection_id for a run with no collection scope at all.
 */
ScriptVariableScopes load_script_variable_scopes (vayu::db::Database& db,
const std::optional<std::string>& environment_id,
const std::string& collection_id);

/**
 * Persist script-set variables (design mode only; best-effort).
 *
 * A scope is rewritten only when a script actually changed one of its
 * variables - see the definition for why that diff is load-bearing (issue
 * #135). Failures are logged and swallowed: the run's result must not depend on
 * a variable write.
 */
void persist_script_variables (vayu::db::Database& db,
const vayu::db::Run& run,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables);

/** As above, for a run whose collection scope is named rather than derived. */
void persist_script_variables (vayu::db::Database& db,
const std::optional<std::string>& environment_id,
const std::string& collection_id,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables);

/**
 * Build the `trace_data` JSON one exchange persists (request + response, the
 * subset `restore-response.ts` restores a response pane from).
 *
 * The stored trace is a contract - the app rebuilds a response pane from it
 * after a restart, so what lands here decides what a restored tab can show, and
 * `execution_trace_test.cpp` drives this directly for that reason.
 *
 * Timing carries all eight `*Ms` keys unconditionally - the same set the live
 * `/execute` response serializes and the load-mode success writer stores - and
 * a skipped phase (reused connection, plain HTTP) is stored as 0, exactly as
 * the live response reports it. Rows written by older engines omitted zero
 * phases and the three totals, so readers must keep defaulting missing keys.
 */
nlohmann::json build_result_trace (const vayu::Request& request,
const vayu::Response& response);

/** Execute one script, turning any exception into a failed `ScriptResult`. */
vayu::ScriptResult execute_script (vayu::runtime::ScriptEngine& engine,
const std::string& script,
vayu::runtime::ScriptContext& ctx,
const std::string& script_type);

/**
 * Point @p ctx's four variable scopes at @p scopes, and nothing else.
 *
 * The leaf collection scope is handed over writable while its ancestors are
 * read-only (issue #234); that rule is the reason this is a function rather
 * than four assignments at each call site.
 *
 * Separate from `bind_script_scopes` because a **deferred** replay - a load
 * run's `tests` script, a scenario load run's per-step script - has scopes to
 * read but no transfer and therefore no cookie jar to bind (issue #728). It
 * must not be the call site that re-derives which scope is writable.
 */
void bind_variable_scopes (vayu::runtime::ScriptContext& ctx, ScriptVariableScopes& scopes);

/**
 * Point @p ctx's variable scopes and cookie surfaces at this run's.
 *
 * The rules here are not obvious and each one is load-bearing: the leaf
 * collection scope is writable while its ancestors are not (issue #234), and
 * every script of a run shares one jar so `pm.cookies` and the transfer cannot
 * disagree about which session they are looking at (issue #301). A second copy
 * of the block would be a copy that stops receiving those fixes, so the
 * streaming path (execution.cpp), which brackets a transfer this function's
 * usual caller does not own, binds through here too.
 *
 * Identity - `request_id`, `request_name`, the iteration fields - stays with
 * the caller: only it knows what this script is running as.
 *
 * @param writes Where `pm.cookies.jar()` stages this script's writes, or null
 *               to refuse them. Never shared between two scripts: each set is
 *               applied exactly once, by the transfer that follows it or by the
 *               caller when none does.
 */
void bind_script_scopes (vayu::runtime::ScriptContext& ctx,
ScriptVariableScopes& scopes,
vayu::http::CookieJar& jar,
const std::string& cookie_scope,
std::vector<vayu::http::CookieWrite>* writes);

/**
 * One exchange's inputs: a composed, auth-resolved request and the scripts
 * that bracket it.
 *
 * `iteration` / `iteration_count` / `iteration_data` belong to a caller that
 * binds a row: the scenario runner, per iteration, and `POST /execute` when the
 * payload names a `data` row (issue #601, where the send is row 0 of 1). Every
 * other caller leaves them unset so `pm.info.iteration` and `pm.iterationData`
 * read `undefined` (issues #300 and #356, and see ScriptContext).
 */
struct ExchangeInputs {
    vayu::Request request;
    std::string pre_script;
    std::string post_script;
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    std::optional<size_t> iteration;
    std::optional<size_t> iteration_count;
    /// Whether the scripts may redirect the sequence around this exchange -
    /// the scenario runner's alone, exactly as `iteration` is (issue #355).
    bool in_scenario = false;
    /// The data row this iteration binds to `pm.iterationData`, or null when
    /// the run has none. Borrowed for the length of the call and outlived by
    /// the run's `ScenarioExecution` (issue #356).
    const nlohmann::json* iteration_data = nullptr;
    /// How this exchange's send - and any `pm.sendRequest` its scripts make -
    /// reaches the network (issue #705). Carried on the inputs rather than
    /// resolved here because `execute_exchange` holds no `Database`; the two
    /// callers that do (the design route and the scenario runner) resolve it
    /// once and hand it down.
    vayu::http::TransportPolicy transport;
};

/** What one exchange produced. */
struct ExchangeOutcome {
    /// The request as it went out - i.e. after the pre-request script's
    /// write-back, which is what the stored trace and the app's raw-request
    /// view must show.
    vayu::Request request;
    vayu::Response response;
    vayu::ScriptResult pre_script_result;
    vayu::ScriptResult post_script_result;
    /**
     * Whether the request was actually sent.
     *
     * False only when the pre-request script called
     * `pm.execution.skipRequest()`: `response` is then default-constructed,
     * which reports neither an error nor a status, so a caller that classified
     * the outcome from the response alone would call a skipped step a pass -
     * the false-pass class issue #180 exists to eliminate. The test script does
     * not run on that path either; there is no response for it to assert on.
     */
    bool sent = true;
};

/**
 * Run one exchange: pre-request script, send, test script.
 *
 * @param engine     Reused across calls; contexts are pooled, so a scenario run
 *                   builds one engine and spends it on every step.
 * @param jar        The environment's cookie jar, shared by the send and by
 *                   both scripts' `pm.cookies` so they cannot disagree about
 *                   which session they are looking at.
 * @param cookie_scope  The environment id, or `NO_ENVIRONMENT_SCOPE`.
 * @param scopes     Mutated in place: this is how a script's
 * `pm.environment.set` in one step is readable by the next.
 *
 * The pre-request script's jar writes ride the send that follows; the test
 * script's are applied here, because no transfer is left to carry them. Either
 * way exactly once - see cookie_jar.hpp.
 *
 * Persisting the result is deliberately *not* here: a design run stores one row
 * and flips the run's status, a scenario run stores one row per step and
 * decides an outcome from the test results. Only the caller knows which.
 */
ExchangeOutcome execute_exchange (vayu::runtime::ScriptEngine& engine,
vayu::http::CookieJar& jar,
const std::string& cookie_scope,
ScriptVariableScopes& scopes,
ExchangeInputs inputs,
bool verbose);

} // namespace vayu::http::routes
