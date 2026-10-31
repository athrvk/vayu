#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_internal.hpp
 * @brief What the translation units behind the `pm` object share (issue
 *        #2092): `script_engine.cpp` and every file under `pm/`, nothing
 *        else.
 *
 * Everything here is in the named namespace `vayu::runtime::pm_detail`, never
 * an anonymous one: an anonymous namespace in a header is a separate copy per
 * including unit, which for a class id is two ids for one class - the
 * silent-segfault class #1589 closed. A helper one surface needs stays in its
 * own file's anonymous namespace; one that two files need is declared here.
 *
 * Not linted, like everything under `engine/src/runtime/` (its `.clang-tidy`
 * says why).
 */

#ifdef VAYU_HAS_QUICKJS

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "vayu/runtime/script_engine.hpp"

// Disable warnings for QuickJS C header in C++ code
#if defined(__clang__) || defined(__GNUC__)
#pragma GCC diagnostic push
#if defined(__clang__)
// Must come first: the names below are not all known to every Clang
// (-Wcast-function-type-mismatch is 19+), and an unrecognised one is itself a
// warning - which VAYU_WERROR turns into a build failure, so the suppression
// block would break the build it exists to keep quiet.
#pragma GCC diagnostic ignored "-Wunknown-warning-option"
#pragma GCC diagnostic ignored "-Wc99-extensions"
#pragma GCC diagnostic ignored "-Wcast-function-type-mismatch"
#pragma GCC diagnostic ignored "-Wshorten-64-to-32"
#endif
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif
extern "C" {
#include "quickjs.h"
}
#if defined(__clang__) || defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace vayu::runtime::pm_detail {

// Per-runtime deadline state for the interrupt handler. One instance is owned by
// each pooled JSRuntime (stored as its runtime opaque) and refreshed before every
// execution. QuickJS runtimes are single-threaded, and each pooled context pair is
// used by one thread at a time, so no synchronization is needed here.
//
// Declared here rather than beside the interrupt handler in script_engine.cpp
// because `pm.sendRequest` reads the same deadline to bound a blocking call:
// QuickJS only calls the interrupt handler *between bytecode operations*, so a
// C function that blocks never yields to it and the deadline has to be consulted
// by hand. One struct, so the budget the handler enforces and the budget the
// clamp reads cannot drift.
struct RuntimeState {
    bool enabled = false; // false => no wall-clock limit (timeout_ms == 0)
    std::chrono::steady_clock::time_point deadline{};
    /// Set by the interrupt handler when it stops a call, cleared before each
    /// execution and before each call an assertion makes into the script. The
    /// handler is the only thing that knows *why* a call ended, and an
    /// assertion that calls back into the script cannot tell the engine's abort
    /// from a value the script threw: both arrive as a pending exception at the
    /// call site. See `arm_script_deadline_watch` and `script_deadline_expired`.
    bool interrupted = false;
    /// The script stack budget this runtime was configured with, which
    /// `load_library` restores after a library's evaluation raised it. 0 is
    /// QuickJS's "no limit".
    std::size_t stack_size = 0;
    /// Promises rejected with no handler attached, in rejection order, each a
    /// reference the rejection tracker took (#2531). Emptied, every reference
    /// freed, before an execution releases its context: a held promise pins
    /// the context exactly as a queued job does (#1823).
    std::vector<JSValue> unhandled_rejections;
};

/// One `setTimeout` / `setInterval` registration (#2577): owned references to
/// the callback and the extra arguments it is called with.
struct ScriptTimer {
    JSValue callback = JS_UNDEFINED;
    std::vector<JSValue> args;
    /// The repeat period of a `setInterval`; nullopt for a `setTimeout`.
    std::optional<double> interval_ms;
};

/**
 * What `setTimeout` and `setInterval` queued, run to completion before the
 * script ends (#2577). The clock is virtual: firing a timer moves it to that
 * timer's due time, so the queue runs in due order without the thread ever
 * waiting, and a tie goes to the timer queued first.
 *
 * Per-execution, like the rest of `ContextData`, and every reference it holds
 * is freed by `clear` before the context is released: a held function pins its
 * context exactly as a queued promise job does (#1823).
 */
class TimerQueue {
    public:
    /// Queues @p timer @p delay_ms after the clock's current time and returns
    /// the id `clearTimeout` takes.
    int64_t schedule (ScriptTimer timer, double delay_ms);
    /// Drops the timer @p id, if one is queued; an unknown id is no error.
    void cancel (JSContext* ctx, int64_t id);
    /// Removes the timer due first and moves the clock to its due time. A
    /// `setInterval` is queued again one period later under the same id
    /// before it is returned, so its own callback can clear it; what comes back
    /// is then a second set of references. The caller frees what it is given.
    /// Only called on a non-empty queue.
    ScriptTimer take_next (JSContext* ctx);
    /// Frees every reference the queue holds and empties it.
    void clear (JSContext* ctx);
    [[nodiscard]] bool empty () const {
        return timers_.empty ();
    }
    [[nodiscard]] std::size_t size () const {
        return timers_.size ();
    }

    private:
    /// (due time on the virtual clock, queue order).
    using Slot = std::pair<double, uint64_t>;
    struct Entry {
        ScriptTimer timer;
        Slot slot;
    };
    void place (int64_t id, Entry entry, double due_ms);

    double now_ms_     = 0;
    uint64_t next_seq_ = 0;
    int64_t next_id_   = 1;
    std::map<Slot, int64_t> order_;
    std::unordered_map<int64_t, Entry> timers_;
};

/// Frees the references @p timer holds.
void free_script_timer (JSContext* ctx, ScriptTimer& timer);

// Context data stored in JS runtime
struct ContextData {
    std::vector<TestResult> tests;
    std::vector<ConsoleEntry> console_output;

    /**
     * The one way a console line is recorded: `console.*`, the cookie jar's and
     * the visualizer's warnings all come through here, never through
     * `console_output.push_back` (#3134). Cuts @p message at
     * `CONSOLE_LINE_MAX_BYTES` on a character boundary, and once the entry or
     * total-bytes cap is reached drops every further line, keeping one final
     * warning that says so. Never throws into the script.
     */
    void add_console_entry (ConsoleLevel level, std::string message);

    /// Bytes of `console_output` messages kept so far (the limit marker aside).
    std::size_t console_bytes = 0;
    /// Set when the limit marker has been written; nothing is kept after it.
    bool console_capped = false;

    const Request* request                              = nullptr;
    const Response* response                            = nullptr;
    Environment* environment                            = nullptr;
    Environment* globals                                = nullptr;
    Environment* collectionVariables                    = nullptr;
    const std::vector<Environment>* collectionAncestors = nullptr;
    /// `ScriptContext::local`, or `script_local` when the caller bound none.
    Environment* local = nullptr;
    Environment script_local;
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    std::optional<ScriptEvent> event;
    std::optional<size_t> iteration;
    /// The virtual user `pm.info.vu` reads, 1-based - see `ScriptContext::vu`.
    std::optional<size_t> vu;
    std::optional<size_t> iteration_count;
    /// `pm.info.run` - see `ScriptContext::run_summary`, which owns the
    /// rationale.
    std::optional<RunSummaryInfo> run_summary;
    /// The row `pm.iterationData` reads, or null - see
    /// `ScriptContext::iteration_data`, which owns the rationale.
    const nlohmann::json* iteration_data = nullptr;
    /// The stream's stored `events` trace node `pm.response.events` reads, or
    /// null - see `ScriptContext::response_events`, which owns the rationale.
    const nlohmann::json* response_events = nullptr;
    /// The hops `pm.response.redirects` reads, or null - see
    /// `ScriptContext::redirect_hops`, which owns the rationale.
    const std::vector<RedirectHop>* redirect_hops = nullptr;
    bool has_error                                = false;
    std::string error_message;

    /**
     * Whether `pm.sendRequest` may send - see
     * `ScriptConfig::allow_send_request` for why the default is deny.
     */
    bool allow_send_request = false;

    /**
     * How many requests this execution has already issued. Per-execution
     * state, not per-context: contexts are pooled and reused, so a counter
     * living on the context would let the first script spend the second
     * script's budget.
     */
    int send_request_count = 0;

    /**
     * The hosts this execution has addressed through `pm.sendRequest`, in the
     * form `cookie_scope_host` answers. `pm.cookies.jar()`'s reads and writes may
     * name these as well as the request's own site (#2358, #2631): a script that
     * logged in somewhere has earned the right to read what that login set. Recorded
     * when the call is made, so a transfer that fails still counts, and
     * per-execution for the same reason `send_request_count` is.
     */
    std::vector<std::string> addressed_hosts;

    /// What `pm.cookies` reads and `pm.sendRequest` sends through - see
    /// `ScriptContext::cookie_jar`, which owns the rationale.
    vayu::http::CookieJar* cookie_jar = nullptr;
    std::string cookie_scope{ vayu::http::NO_ENVIRONMENT_SCOPE };

    /// Where `pm.cookies.jar()` stages its writes - see
    /// `ScriptContext::cookie_writes`. Drained by `pm.sendRequest`, which
    /// hands them to the auxiliary transfer.
    std::vector<vayu::http::CookieWrite>* cookie_writes = nullptr;

    /// A read-only per-VU cookie view for an inline load-run script - see
    /// `ScriptContext::cookie_read_lines`, which owns the rationale.
    const std::vector<std::string>* cookie_read_lines = nullptr;

    /// What a flat `pm.cookies` read throws with neither a jar nor a
    /// per-VU view - see `ScriptContext::cookie_read_refusal`.
    const char* cookie_read_refusal = nullptr;

    /// How `pm.sendRequest` reaches the network - see
    /// `ScriptContext::transport`, which owns the rationale.
    vayu::http::TransportPolicy transport;

    /// What the engine adds to a `pm.sendRequest` - see
    /// `ScriptContext::default_headers`, which owns the rationale.
    vayu::http::DefaultHeaderPolicy default_headers;

    /// How much of a `pm.sendRequest` response body is read before the
    /// transfer is refused - see `ScriptContext::max_response_bytes`, which
    /// owns the rationale and the per-path choice.
    size_t max_response_bytes = vayu::core::constants::http::MAX_DESIGN_RESPONSE_BODY_BYTES;

    /// The timeout a `pm.sendRequest` without a `timeout` option takes - see
    /// `ScriptContext::request_timeout_ms`.
    int request_timeout_ms = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;

    /// What ends a `pm.sendRequest` early, or null - see
    /// `ScriptContext::cancel`.
    const std::atomic<bool>* cancel = nullptr;

    /// Whether `pm.execution` may record an intent at all - see
    /// `ScriptContext::in_scenario`.
    bool in_scenario = false;

    /// `pm.metrics`'s write destination, or null to refuse it - see
    /// `ScriptContext::record_metric`.
    std::function<void (const std::string& name, vayu::core::CustomMetricType type, double value)> record_metric;

    /// What `pm.execution` recorded, copied onto the `ScriptResult` at the end
    /// of the execution. Per-execution like the rest of this struct, so a
    /// pooled context cannot carry one script's jump into the next.
    ScriptControl control;

    /// The promise each `pm.test` callback returned, with that test's name,
    /// so a rejection can name its test and a promise that never settled can
    /// be reported (#2531). Owned references, freed with the tracker's before
    /// the context is released.
    std::vector<std::pair<JSValue, std::string>> async_tests;

    /// What `setTimeout` and `setInterval` queued in this execution.
    TimerQueue timers;

    /// The promise the script's async wrapper returned (#2577), which rejects
    /// with what the body throws, before its first `await` or after one. An
    /// owned reference, freed before the context is released; undefined once
    /// its rejection has been reported.
    JSValue script_body = JS_UNDEFINED;

    /// The `tests` object the legacy globals bind (#2577), read once the script
    /// has finished. The object bound, not whatever the global names by then,
    /// as Postman reads it. An owned reference, freed before the context is
    /// released.
    JSValue legacy_tests = JS_UNDEFINED;

    /// The shelf libraries this execution has loaded, by the name `require`
    /// takes (#2578). Owned references, freed by `release_shelf_modules`
    /// before the context is released.
    std::map<std::string_view, JSValue> shelf_modules;
};

// Get context data from JS context
inline ContextData* get_context_data (JSContext* ctx) {
    return static_cast<ContextData*> (JS_GetContextOpaque (ctx));
}

// Milliseconds left of this execution's wall-clock budget, or nullopt when the
// engine was configured without one (timeout_ms == 0). May be negative: the
// caller decides whether an already-blown budget is an error or a clamp.
inline std::optional<int64_t> remaining_script_budget_ms (JSContext* ctx) {
    auto* state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (JS_GetRuntime (ctx)));
    if (!state || !state->enabled) {
        return std::nullopt;
    }
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    state->deadline - std::chrono::steady_clock::now ())
    .count ();
}

// Clears the handler's record before a call an assertion is about to make into
// the script, so that `script_deadline_expired` afterwards answers about *that
// call* rather than about the execution so far. The distinction is not
// theoretical: `pm.test` consumes an abort natively and lets the script run on,
// and QuickJS gives it a fresh 10,000-operation budget before the next poll -
// so a flag left standing would read the ordinary throw in the next test as an
// abort too, failing an assertion that holds.
inline void arm_script_deadline_watch (JSContext* ctx) {
    if (auto* state =
        static_cast<RuntimeState*> (JS_GetRuntimeOpaque (JS_GetRuntime (ctx)))) {
        state->interrupted = false;
    }
}

// Whether the wall-clock deadline stopped the call just made. Asked by the
// assertions that call back into the script: the interrupt stops the call by
// raising an exception into it, which at the call site is indistinguishable
// from one the script threw, so reading a pending exception as "the function
// threw" reports a pass about a function that never returned. The handler's own
// flag is the only honest answer - comparing the clock here would also call a
// script's ordinary throw a timeout when it happened to land past the deadline.
inline bool script_deadline_expired (JSContext* ctx) {
    auto* state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (JS_GetRuntime (ctx)));
    return state != nullptr && state->enabled && state->interrupted;
}

// Frees a borrowed JSValue on every exit. QuickJS ships no such helper, and the
// surfaces that read a handful of properties and refuse on most of them - the
// pm.request write-back, pm.sendRequest's options object, the Url query
// writers - each have several early returns to leak from.
class ScopedValue {
    public:
    ScopedValue (JSContext* ctx, JSValue value) : ctx_ (ctx), value_ (value) {
    }
    ~ScopedValue () {
        JS_FreeValue (ctx_, value_);
    }
    ScopedValue (const ScopedValue&)            = delete;
    ScopedValue& operator= (const ScopedValue&) = delete;
    [[nodiscard]] JSValue get () const {
        return value_;
    }

    private:
    JSContext* ctx_;
    JSValue value_;
};

// Convert JS string to C++ string
inline std::string js_to_string (JSContext* ctx, JSValue val) {
    const char* str = JS_ToCString (ctx, val);
    if (!str)
        return "";
    std::string result (str);
    JS_FreeCString (ctx, str);
    return result;
}

// Each class's id, process-wide: assigned once, under
// `class_id_registration_mutex ()`, by the first `ScriptEngine::Impl` to build
// a runtime (#1589). Declared here and defined once, beside the class's
// `JSClassDef`, so every unit reads the one object `JS_NewClassID` wrote.
extern JSClassID request_url_class_id;
extern JSClassID request_body_class_id;
extern JSClassID expect_class_id;
extern JSClassID expect_member_class_id;
extern JSClassID response_chain_class_id;

// The definitions `ScriptEngine::Impl` registers those ids with. Each stays in
// the unit that defines its finalizer and exotic hooks.
extern JSClassDef request_url_class;
extern JSClassDef request_body_class;
extern JSClassDef expect_class;
extern JSClassDef expect_member_class;
extern JSClassDef response_chain_class;

// Reads a hash input into @p out: a string as its UTF-8 bytes, a Uint8Array as
// its bytes. Anything else leaves a TypeError naming @p what pending and
// answers false (script_engine.cpp, shared with the require shelf's natives).
bool read_crypto_bytes (JSContext* ctx, JSValueConst value, const char* what, std::string& out);

// `require` and the library globals over the bundled shelf (require_shelf.cpp,
// #2578). `setup_require_shelf` installs them on a context and evaluates no
// library; `release_shelf_modules` frees what an execution loaded.
void setup_require_shelf (JSContext* ctx);
void release_shelf_modules (JSContext* ctx, ContextData& data);
// How many times this process has evaluated a shelf library's source.
std::size_t shelf_library_loads ();

// Name a rejected value the way the script author wrote it, so the error says
// "got number" rather than showing them a coerced "[object Object]".
const char* js_type_name (JSContext* ctx, JSValueConst value);

// The `pm.expect` primitives `pm.response.to` shares, defined beside the
// rest of `pm.expect`: the AssertionError throw, a value as a failure message
// quotes it, the unknown-member hook body both chains share, own enumerable
// keys, and deep equality.
JSValue throw_assertion_failure (JSContext* ctx, const std::string& message);
std::string js_describe (JSContext* ctx, JSValueConst val);
int report_unknown_chain_member (JSContext* ctx, JSValueConst obj, JSAtom prop, const char* path);
bool js_own_enumerable_keys (JSContext* ctx, JSValueConst obj, std::vector<std::string>& out);

// One level of the comparison path: the two objects being compared. Compared
// by identity, which is what a cycle is.
using DeepEqualPath = std::vector<std::pair<void*, void*>>;

// Whether a deep comparison separates `+0` from `-0`, which is the one rule the
// two libraries Vayu answers for do not share: chai's `.eql` runs on deep-eql,
// whose number rule is `x === y && (x !== 0 || 1/x === 1/y)`, while the response
// assertions match chai-postman, which runs on lodash `_.isEqual` and compares
// the two as equal. Stated by the caller rather than picked once for both, so
// neither contract has to be the one that is quietly wrong.
enum class ZeroRule { SameValueZero, Signed };

int js_deep_equal (JSContext* ctx, JSValueConst a, JSValueConst b, int depth, DeepEqualPath& path, ZeroRule zeros);

// The two numbers chai-postman's `responseTime` / `responseSize` chainables
// retarget an assertion at (#2528).
enum class ResponseMeasure { Time, Size };

// `pm.response.to.have.responseTime` / `.responseSize`: a `pm.expect` chain
// on @p measured, negated when @p negated (the `not` read before it), that is
// also the call `responseTime(value)` chai-postman defines (pm_expect.cpp).
JSValue response_measure_chain (JSContext* ctx, double measured, bool negated, ResponseMeasure which);

// `jsonSchema`'s verdict on @p document, shared by `pm.expect(...)` and
// `pm.response.to.have` (pm_expect.cpp): the failure message when the
// assertion fails under @p negated, empty when it holds, nullopt with an
// exception pending when @p schema is not a schema or a value has no JSON form.
std::optional<std::string>
json_schema_failure (JSContext* ctx, JSValueConst document, JSValueConst schema, bool negated);

// `pm.test`, `pm.expect` and `pm.expect.fail` (pm_expect.cpp), which
// `setup_pm_object` installs.
JSValue js_pm_test (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv);
JSValue js_pm_expect (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv);
JSValue js_pm_expect_fail (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv);

// `pm.visualizer` (pm_visualizer.cpp): Postman's calls, accepted with a
// console warning.
void setup_pm_visualizer (JSContext* ctx, JSValue pm);

// `pm.execution` and `pm.metrics` (pm_execution_metrics.cpp).
void setup_pm_execution (JSContext* ctx, JSValue pm);
void setup_pm_metrics (JSContext* ctx, JSValue pm);

// The variable scopes, `pm.variables` and `pm.iterationData` (pm_scopes.cpp).
void setup_pm_variable_scopes (JSContext* ctx, JSValue pm);
void setup_pm_variables (JSContext* ctx, JSValue pm);
void setup_pm_iteration_data (JSContext* ctx, JSValue pm);

// `{{...}}` resolution against everything a script can see, and the refusal
// for a data column the bound row does not carry; `pm.variables.replaceIn` and
// `pm.sendRequest` both go through these so they cannot answer differently.
std::optional<std::string> resolve_script_template (JSContext* ctx,
const std::string& input,
std::string& missing_column);
std::string
missing_column_message (JSContext* ctx, const std::string& what, const std::string& column);

// `pm.sendRequest` (pm_send_request.cpp).
JSValue js_pm_send_request (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv);

// `pm.cookies` and `pm.response.cookies` (pm_cookies.cpp). The second is the
// getter `setup_pm_response` installs.
void setup_pm_cookies (JSContext* ctx, JSValue pm);
JSValue js_response_cookies (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv);

// Postman's `cookies.one(name)`: the cookie `pm.cookies.get(name)` reads, as
// the whole object `pm.cookies.all()` lists, or undefined. Not a member of
// `pm.cookies`; `postman.getResponseCookie` is its one caller (pm_legacy.cpp).
JSValue js_jar_cookies_one (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv);

// Postman's pre-`pm.*` globals (pm_legacy.cpp, #2577): the `postman` object,
// whose helper methods alias the `pm` members Postman names as their
// replacements, and the values (`tests`, `environment`, `responseBody`, ...)
// read off `pm` when the script starts. Installed per execution, after the
// `pm` surfaces are refreshed, because the response globals exist only where
// there is a response, as in Postman.
void setup_postman_legacy (JSContext* ctx, JSValue global, JSValue pm);

// Appends a result to `data.tests` for each property of the `tests` object, in
// its key order, as Postman does once the script has finished.
void record_legacy_tests (JSContext* ctx, ContextData& data);

// `pm.request` and `pm.info` (pm_request_url.cpp), and the write-back that
// applies a pre-request script's `pm.request` to the request about to be sent.
void setup_pm_request (JSContext* ctx, JSValue pm);
void setup_pm_info (JSContext* ctx, JSValue pm);
std::optional<std::string> apply_pm_request_writeback (JSContext* ctx, Request& request);

// The header lines a script reads as the request's: the sent record in a test
// script, the composed request before the send (pm_request_url.cpp).
const HeaderList& script_request_header_lines (const ContextData& data);

// The state behind a `pm.request.url` Url object, or nullptr for anything
// else - a class test, so the jar can tell a Url from a forged look-alike.
struct RequestUrlState;
RequestUrlState* request_url_state (JSValueConst value);

// `pm.request.url`: the URL a string or a Url object carries, nullopt for
// anything else.
std::optional<std::string>
script_url_text (JSContext* ctx, JSValueConst value, std::string* out_error = nullptr);

// The text `pm.expect` reads a string-like target as: a string, or the Url or
// RequestBody object that replaced one on `pm.request`; nullopt otherwise.
std::optional<std::string> expect_string_like (JSContext* ctx, JSValueConst value);

// Header objects, shared by `pm.request`, `pm.response` and `pm.sendRequest`.
void define_header_entry (JSContext* ctx,
JSValue headers,
const std::string& name,
const std::string& value);
void install_header_methods (JSContext* ctx, JSValue headers, bool mutators);
std::optional<std::string> read_header_object (JSContext* ctx,
JSValueConst js_headers,
const char* label,
bool suggest_delete,
Headers& out);

// `pm.response` (pm_response.cpp): its installer, the reason phrase
// `reason()` answers, and json()/text().
void setup_pm_response (JSContext* ctx, JSValue pm);
std::string response_reason_phrase (const Response& response);
void install_response_body_readers (JSContext* ctx, JSValue response, const std::string& body);

} // namespace vayu::runtime::pm_detail

#endif // VAYU_HAS_QUICKJS
