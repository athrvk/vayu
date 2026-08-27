/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file script_engine.cpp
 * @brief QuickJS-based JavaScript scripting engine implementation
 *
 * This file interfaces with QuickJS C library and uses different coding conventions.
 *
 * Nothing here is linted: `engine/src/runtime/.clang-tidy` turns every check off
 * for this directory, with the reason. There used to be a file-wide
 * NOLINTBEGIN/NOLINTEND pair saying the same thing a second way (#885) - two
 * mechanisms for one exemption, the weaker of which silently stops covering the
 * file the moment a function is moved out of it.
 */

#include "vayu/runtime/script_engine.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <iterator>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "vayu/http/client.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/set_cookie.hpp"
#include "vayu/http/status.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/sha256.hpp"

#ifdef VAYU_HAS_QUICKJS
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

#endif

namespace vayu::runtime {

#ifdef VAYU_HAS_QUICKJS

// Per-runtime deadline state for the interrupt handler. One instance is owned by
// each pooled JSRuntime (stored as its runtime opaque) and refreshed before every
// execution. QuickJS runtimes are single-threaded, and each pooled context pair is
// used by one thread at a time, so no synchronization is needed here.
//
// Declared up here rather than beside the interrupt handler below because
// `pm.sendRequest` reads the same deadline to bound a blocking call: QuickJS
// only calls the interrupt handler *between bytecode operations*, so a C
// function that blocks never yields to it and the deadline has to be consulted
// by hand. One struct, so the budget the handler enforces and the budget the
// clamp reads cannot drift.
struct RuntimeState {
    bool enabled = false; // false => no wall-clock limit (timeout_ms == 0)
    std::chrono::steady_clock::time_point deadline{};
};

// ============================================================================
// QuickJS Helper Functions
// ============================================================================

namespace {
// Context data stored in JS runtime
struct ContextData {
    std::vector<TestResult> tests;
    std::vector<ConsoleEntry> console_output;
    const Request* request                              = nullptr;
    const Response* response                            = nullptr;
    Environment* environment                            = nullptr;
    Environment* globals                                = nullptr;
    Environment* collectionVariables                    = nullptr;
    const std::vector<Environment>* collectionAncestors = nullptr;
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    std::optional<ScriptEvent> event;
    std::optional<size_t> iteration;
    std::optional<size_t> iteration_count;
    /// The row `pm.iterationData` reads, or null - see
    /// `ScriptContext::iteration_data`, which owns the rationale.
    const nlohmann::json* iteration_data = nullptr;
    /// The stream's stored `events` trace node `pm.response.events` reads, or
    /// null - see `ScriptContext::response_events`, which owns the rationale.
    const nlohmann::json* response_events = nullptr;
    bool has_error                        = false;
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

    /// What `pm.cookies` reads and `pm.sendRequest` sends through - see
    /// `ScriptContext::cookie_jar`, which owns the rationale.
    vayu::http::CookieJar* cookie_jar = nullptr;
    std::string cookie_scope{ vayu::http::NO_ENVIRONMENT_SCOPE };

    /// Where `pm.cookies.jar()` stages its writes - see
    /// `ScriptContext::cookie_writes`. Drained by `pm.sendRequest`, which
    /// hands them to the auxiliary transfer.
    std::vector<vayu::http::CookieWrite>* cookie_writes = nullptr;

    /// How `pm.sendRequest` reaches the network - see
    /// `ScriptContext::transport`, which owns the rationale.
    vayu::http::TransportPolicy transport;

    /// Whether `pm.execution` may record an intent at all - see
    /// `ScriptContext::in_scenario`.
    bool in_scenario = false;

    /// What `pm.execution` recorded, copied onto the `ScriptResult` at the end
    /// of the execution. Per-execution like the rest of this struct, so a
    /// pooled context cannot carry one script's jump into the next.
    ScriptControl control;
};

// Get context data from JS context
ContextData* get_context_data (JSContext* ctx) {
    return static_cast<ContextData*> (JS_GetContextOpaque (ctx));
}

// Milliseconds left of this execution's wall-clock budget, or nullopt when the
// engine was configured without one (timeout_ms == 0). May be negative: the
// caller decides whether an already-blown budget is an error or a clamp.
std::optional<int64_t> remaining_script_budget_ms (JSContext* ctx) {
    auto* state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (JS_GetRuntime (ctx)));
    if (!state || !state->enabled) {
        return std::nullopt;
    }
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    state->deadline - std::chrono::steady_clock::now ())
    .count ();
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
std::string js_to_string (JSContext* ctx, JSValue val) {
    const char* str = JS_ToCString (ctx, val);
    if (!str)
        return "";
    std::string result (str);
    JS_FreeCString (ctx, str);
    return result;
}

// ============================================================================
// Variable Type Casting
// ============================================================================

// Convert a stored Variable into a JSValue of its declared type. The on-disk
// value is always a string - type drives the conversion (mirrors the frontend
// castByType in app/src/lib/variable-cast.ts so reads are consistent across
// both runtimes).
JSValue cast_variable_to_jsvalue (JSContext* ctx, const Variable& var) {
    const std::string& type = var.type.empty () ? std::string{ "string" } : var.type;

    if (type == "number") {
        if (var.value.empty ())
            return JS_NewFloat64 (ctx, std::numeric_limits<double>::quiet_NaN ());
        try {
            size_t idx = 0;
            double num = std::stod (var.value, &idx);
            // If the whole string didn't parse, surface NaN to match the
            // frontend's Number(value) behavior on partial garbage.
            if (idx != var.value.size ())
                return JS_NewFloat64 (ctx, std::numeric_limits<double>::quiet_NaN ());
            return JS_NewFloat64 (ctx, num);
        } catch (...) {
            return JS_NewFloat64 (ctx, std::numeric_limits<double>::quiet_NaN ());
        }
    }

    if (type == "boolean") {
        std::string lowered = var.value;
        std::transform (lowered.begin (), lowered.end (), lowered.begin (),
        [] (unsigned char c) { return std::tolower (c); });
        // Trim whitespace
        auto isspace_pred = [] (unsigned char c) { return std::isspace (c); };
        while (!lowered.empty () &&
        isspace_pred (static_cast<unsigned char> (lowered.front ())))
            lowered.erase (lowered.begin ());
        while (!lowered.empty () &&
        isspace_pred (static_cast<unsigned char> (lowered.back ())))
            lowered.pop_back ();

        if (lowered == "true" || lowered == "1" || lowered == "yes")
            return JS_NewBool (ctx, 1);
        if (lowered == "false" || lowered == "0" || lowered == "no" || lowered.empty ())
            return JS_NewBool (ctx, 0);
        // Non-canonical truthy string: matches Boolean("foo") → true
        return JS_NewBool (ctx, 1);
    }

    if (type == "json") {
        // JS_ParseJSON returns an exception JSValue on parse failure; fall
        // back to the raw string so the script author can debug.
        JSValue parsed =
        JS_ParseJSON (ctx, var.value.c_str (), var.value.size (), "<variable>");
        if (JS_IsException (parsed)) {
            JS_FreeValue (ctx, parsed);
            // Clear the pending exception so it doesn't leak into the script
            JSValue err = JS_GetException (ctx);
            JS_FreeValue (ctx, err);
            return JS_NewString (ctx, var.value.c_str ());
        }
        return parsed;
    }

    // Default / "string"
    return JS_NewString (ctx, var.value.c_str ());
}

// ============================================================================
// Console Implementation
// ============================================================================

/**
 * Every `console.*` method, distinguished by QuickJS's `magic` argument.
 *
 * One function rather than four near-copies: the formatting below is the whole
 * body and none of it varies by level. `magic` is how QuickJS passes a small
 * integer to a shared C function, which is exactly the shape of this problem -
 * the alternative is four wrappers that each forward to a fifth.
 */
JSValue
js_console_log (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    auto* data = get_context_data (ctx);
    std::stringstream ss;

    for (int i = 0; i < argc; i++) {
        if (i > 0)
            ss << " ";

        // JS_ToCString on an object invokes Object.prototype.toString() →
        // "[object Object]". Pretty-print objects (and arrays) via
        // JSON.stringify instead, matching standard console.log behavior.
        // Functions are left to JS_ToCString (which yields their source).
        if (JS_IsObject (argv[i]) && !JS_IsFunction (ctx, argv[i])) {
            JSValue indent = JS_NewInt32 (ctx, 2);
            JSValue json = JS_JSONStringify (ctx, argv[i], JS_UNDEFINED, indent);
            JS_FreeValue (ctx, indent);

            if (!JS_IsException (json) && !JS_IsUndefined (json)) {
                const char* str = JS_ToCString (ctx, json);
                if (str) {
                    ss << str;
                    JS_FreeCString (ctx, str);
                }
                JS_FreeValue (ctx, json);
                continue;
            }
            // Stringify threw (e.g. circular reference) or returned undefined.
            // Clear any pending exception and emit a readable placeholder.
            JS_FreeValue (ctx, json);
            JSValue exc = JS_GetException (ctx);
            if (!JS_IsNull (exc) && !JS_IsUndefined (exc)) {
                JS_FreeValue (ctx, exc);
            }
            ss << "[Object: unserializable]";
            continue;
        }

        const char* str = JS_ToCString (ctx, argv[i]);
        if (str) {
            ss << str;
            JS_FreeCString (ctx, str);
        }
    }

    data->console_output.push_back ({ static_cast<ConsoleLevel> (magic), ss.str () });
    return JS_UNDEFINED;
}

void setup_console (JSContext* ctx) {
    JSValue global  = JS_GetGlobalObject (ctx);
    JSValue console = JS_NewObject (ctx);

    // The magic value is the ConsoleLevel, cast back in js_console_log. Keep
    // this table and the enum in step - a wrong number here is a silently
    // mislabelled line, not a compile error.
    struct Method {
        const char* name;
        ConsoleLevel level;
    };
    static constexpr Method METHODS[] = {
        { "log", ConsoleLevel::Log },
        { "info", ConsoleLevel::Info },
        { "warn", ConsoleLevel::Warn },
        { "error", ConsoleLevel::Error },
    };

    for (const auto& method : METHODS) {
        JS_SetPropertyStr (ctx, console, method.name,
        JS_NewCFunctionMagic (ctx, js_console_log, method.name, 1,
        JS_CFUNC_generic_magic, static_cast<int> (method.level)));
    }

    JS_SetPropertyStr (ctx, global, "console", console);
    JS_FreeValue (ctx, global);
}

// ============================================================================
// pm.request.url - the identity half of Postman's Url object
// ============================================================================

/**
 * @brief What `pm.request.url` is, behind the members a script reads.
 *
 * `pm.request.url` was a string primitive; issue #991 records the owner
 * decision that Postman compatibility wins over keeping that shape, so it is
 * now the `Url` object a lifted Postman script expects - `url.query.get(...)`,
 * `url.getPath()`, `url.host` and the rest. The members are built in
 * `build_request_url` further down; what lives up here is the *identity*, which
 * three surfaces before that point need: the `pm.request` write-back, the jar
 * methods and `pm.sendRequest` all had "is this a string?" as their entire
 * type check, and each of them is documented as taking `pm.request.url`.
 *
 * `text` is authoritative and `parts` is derived from it. `built` says whether
 * the JS members have been materialised yet: a script that never mentions the
 * URL never pays for the parse, which is why the property is an accessor rather
 * than a plain member (see `install_request_url`).
 */
struct RequestUrlState {
    std::string text;
    vayu::http::UrlParts parts;
    bool built = false;
    // A member was written to, so `parts` is ahead of `text` (issue #1040).
    // The composition is deferred to whoever needs the whole URL next, and -
    // more to the point - **never happens at all** for a URL nobody edited,
    // which is what keeps `getQueryString()` byte-exact against the wire and
    // keeps a read-only script's request identical to the one it was handed.
    bool dirty = false;
};

// Defined with the header accessors below, and needed here: naming a rejected
// value the way the script author wrote it is the same courtesy on a URL
// member as on a header.
const char* js_type_name (JSContext* ctx, JSValueConst value);

/**
 * @brief Bring the URL up to date with whatever the script did to its members,
 *        and answer the whole URL (issue #1040).
 *
 * Two kinds of edit reach here by two routes. `query.add` and the
 * `protocol`/`port`/`hash` setters are methods, so they update the parts and
 * set `dirty` themselves. `path` and `host` are plain JS arrays a script
 * mutates in place, and nothing tells us when that happened - so they are
 * **read back** here and compared, which is the same rule
 * `apply_pm_request_writeback` already follows for `pm.request.headers`: the
 * object the script holds is what is sent, read at the moment it is needed.
 *
 * Comparing rather than assuming is what keeps the promise that matters: a
 * script that only *read* the URL leaves `dirty` false, nothing is composed,
 * and the request goes out as the exact bytes it arrived as - which is what
 * `getQueryString()` being byte-exact against the wire depends on.
 *
 * @return why the members could not be read, or nullopt when @p state is
 *         current. Never throws: three of the four callers want a JS
 *         exception and the fourth wants a write-back reason, so the message
 *         is handed back rather than raised.
 */
std::optional<std::string>
refresh_url_from_members (JSContext* ctx, JSValueConst url, RequestUrlState& state) {
    if (state.built) {
        struct SegmentList {
            const char* member;
            std::vector<std::string>* parts;
        };
        const std::array<SegmentList, 2> LISTS = { {
        { "path", &state.parts.path },
        { "host", &state.parts.host },
        } };

        for (const auto& [member, target] : LISTS) {
            ScopedValue list (ctx, JS_GetPropertyStr (ctx, url, member));
            if (!JS_IsArray (list.get ())) {
                return "pm.request.url." + std::string (member) + " must be an array of " +
                "strings, got " + std::string (js_type_name (ctx, list.get ()));
            }
            int64_t length = 0;
            if (JS_GetLength (ctx, list.get (), &length) < 0) {
                JS_FreeValue (ctx, JS_GetException (ctx));
                return "pm.request.url." + std::string (member) + " could not be read";
            }
            std::vector<std::string> segments;
            segments.reserve (static_cast<size_t> (length < 0 ? 0 : length));
            for (int64_t i = 0; i < length; i++) {
                ScopedValue element (ctx, JS_GetPropertyInt64 (ctx, list.get (), i));
                // A number is taken - pushing an id onto a path is the obvious
                // case. An object, an array or a hole is refused rather than
                // reaching the wire as "[object Object]" or "undefined".
                if (!JS_IsString (element.get ()) && !JS_IsNumber (element.get ())) {
                    return "pm.request.url." + std::string (member) + " takes strings, got " +
                    std::string (js_type_name (ctx, element.get ())) +
                    " at index " + std::to_string (i);
                }
                segments.push_back (js_to_string (ctx, element.get ()));
            }
            if (segments != *target) {
                if (!state.parts.parsed) {
                    return "pm.request.url." + std::string (member) + " cannot be edited: \"" +
                    state.text + "\" could not be parsed as a URL. Assign a whole URL instead.";
                }
                *target     = std::move (segments);
                state.dirty = true;
            }
        }
    }

    if (state.dirty) {
        state.parts.query = vayu::http::compose_query (state.parts.query_params);
        state.text  = vayu::http::compose_url (state.parts);
        state.dirty = false;
    }
    return std::nullopt;
}

/// The whole URL for a caller with no way to report a bad member - the parts
/// stay as they were and the text is whatever was last composed, which is the
/// URL the write-back will refuse by name a moment later.
const std::string&
request_url_current_text (JSContext* ctx, JSValueConst url, RequestUrlState& state) {
    (void)refresh_url_from_members (ctx, url, state);
    return state.text;
}

JSClassID request_url_class_id = 0;

void request_url_finalizer (JSRuntime* rt, JSValue val) {
    (void)rt;
    delete static_cast<RequestUrlState*> (JS_GetOpaque (val, request_url_class_id));
}

// No gc_mark: the state holds C++ strings, never a JSValue, so it can be part
// of no cycle the collector has to break.
JSClassDef request_url_class = { .class_name = "Url",
    .finalizer                               = request_url_finalizer,
    .gc_mark                                 = nullptr,
    .call                                    = nullptr,
    .exotic                                  = nullptr };

/// The state behind a Url object, or nullptr for anything else. A real class
/// test rather than a marker property, so a script cannot forge one by naming
/// a field the same thing.
RequestUrlState* request_url_state (JSValueConst value) {
    return static_cast<RequestUrlState*> (JS_GetOpaque (value, request_url_class_id));
}

/**
 * @brief The URL a value carries, for the surfaces that used to require a
 *        string and are documented as taking `pm.request.url`.
 *
 * A JS string is itself; a Url object is the string it was built from. Anything
 * else is `nullopt` - the caller says so in its own words, because
 * "pm.sendRequest was given a number" and "jar().set needs a URL" are different
 * sentences about the same refusal.
 *
 * Deliberately *not* "any object, via toString": `pm.request.url = {}` would
 * then become the string `[object Object]` and reach the wire, which is exactly
 * the silent-wrong-request class this program exists to close.
 */
std::optional<std::string>
script_url_text (JSContext* ctx, JSValueConst value, std::string* out_error = nullptr) {
    if (JS_IsString (value)) {
        return js_to_string (ctx, value);
    }
    if (auto* state = request_url_state (value)) {
        // A member the script left in a state the URL cannot be built from is
        // reported by name, through @p out_error where the caller has one -
        // "pm.request.url.path takes strings, got object at index 2" says more
        // than "this is not a URL", and the caller that reports it is the
        // write-back, which is where every other pm.request refusal surfaces.
        if (auto reason = refresh_url_from_members (ctx, value, *state)) {
            if (out_error != nullptr) {
                *out_error = std::move (*reason);
            }
            return std::nullopt;
        }
        return state->text;
    }
    return std::nullopt;
}

// ============================================================================
// pm.expect() Chainable Assertions
// ============================================================================

// Expectation state stored in JS object
struct ExpectState {
    JSValue actual;
    bool negated = false;
    // Set by the `deep` / `nested` chainers and read by the matcher that ends
    // the chain, so `to.deep.equal` and `to.have.nested.property` change what
    // the same matcher compares rather than needing matchers of their own.
    bool deep   = false;
    bool nested = false;
    // chai's second argument to `expect(value, message)`, empty when the script
    // passed one argument. Read only by `throw_expect_failure`. The `{}` keeps
    // `create_expectation`'s two-field aggregate init, which assigns this
    // separately, out of -Wmissing-field-initializers.
    std::string message{};
};

JSClassID expect_class_id = 0;

void expect_finalizer (JSRuntime* rt, JSValue val) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (val, expect_class_id));
    if (state) {
        JS_FreeValueRT (rt, state->actual);
        delete state;
    }
}

void expect_gc_mark (JSRuntime* rt, JSValueConst val, JS_MarkFunc* mark_func) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (val, expect_class_id));
    if (state) {
        JS_MarkValue (rt, state->actual, mark_func);
    }
}

JSClassDef expect_class = { .class_name = "Expectation",
    .finalizer                          = expect_finalizer,
    .gc_mark                            = expect_gc_mark,
    .call                               = nullptr,
    .exotic                             = nullptr };

/**
 * @brief Throw a failed assertion the way chai does - as an `AssertionError`.
 *
 * `pm.expect` is chai, and chai reports a broken assertion as an
 * `AssertionError`. Vayu threw a `TypeError` instead, which is wrong in two
 * ways a user can see (issue #487): the report and the console prefix every
 * failure with `TypeError:`, which reads as an engine fault rather than the
 * assertion doing its job, and a script that inspects what it caught -
 * `catch (e) { if (e.name === "AssertionError") ... }` - takes the other branch
 * than it does in Postman.
 *
 * QuickJS has no `AssertionError` class, so the error is a plain `Error` with
 * the name replaced: `instanceof Error` still holds, `JS_NewError` gives it the
 * same backtrace a native throw would, and `message` is defined with the
 * native errors' attributes (writable, configurable, **not** enumerable) so
 * `JSON.stringify(e)` answers what it always did. No `AssertionError` global is
 * exposed - chai's lives on the `chai` module, which Vayu does not ship, and a
 * bare global would be a name Postman scripts cannot rely on either.
 *
 * Only *assertion* failures come through here. A script-text mistake - a
 * matcher called with no argument, a misspelled name under `pm.response.to` -
 * stays a `TypeError`, in chai as much as here: nothing was asserted, the call
 * itself was wrong.
 */
JSValue throw_assertion_failure (JSContext* ctx, const std::string& message) {
    JSValue error = JS_NewError (ctx);
    if (JS_IsException (error)) {
        return JS_EXCEPTION;
    }
    JS_DefinePropertyValueStr (ctx, error, "name",
    JS_NewString (ctx, "AssertionError"), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr (ctx, error, "message",
    JS_NewString (ctx, message.c_str ()), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw (ctx, error);
}

/**
 * @brief Report a failed assertion, prefixed with the expectation's message.
 *
 * chai's `expect(value, message)` puts the script's own words in front of
 * whatever the matcher reports, which is the whole reason to pass one: the
 * generic text ("Expected value to be truthy") says what broke and the prefix
 * says which value it was - the third item in a loop, the MCP path rather than
 * the app path. Postman scripts use the two-argument form routinely.
 *
 * Every matcher throws its failure through here rather than concatenating the
 * prefix itself, so the prefix is one rule in one place: a matcher added later
 * gets it by throwing the way its neighbours do, and cannot report a bare
 * message by forgetting a concatenation. Usage errors - `above()` with no
 * argument, `members()` against a non-array - deliberately do **not** come
 * through here: they name a mistake in the script text, not the value under
 * test, and their message already names the matcher that rejected the call.
 */
JSValue throw_expect_failure (JSContext* ctx, const ExpectState* state, const std::string& failure) {
    if (state != nullptr && !state->message.empty ()) {
        return throw_assertion_failure (ctx, state->message + ": " + failure);
    }
    return throw_assertion_failure (ctx, failure);
}

// ----------------------------------------------------------------------------
// Value comparison for the equality matchers.
//
// `equal` is strict and `eql` is deep, which is why they cannot share one
// comparison: `expect({a:1}).to.equal({a:1})` must fail (different references)
// while `expect({a:1}).to.eql({a:1})` passes. Chai draws the line there and
// Postman scripts are written against chai.
// ----------------------------------------------------------------------------

// `===` without coercion. No strict-equality entry point exists in both
// vendored runtimes (`JS_IsStrictEqual` is quickjs-ng only; the Unix build is
// Bellard's), so the rules are applied here: no cross-type equality, `NaN` is
// not equal to itself, and objects compare by reference.
bool js_strict_equal (JSContext* ctx, JSValueConst a, JSValueConst b) {
    if (JS_IsNumber (a) || JS_IsNumber (b)) {
        if (!JS_IsNumber (a) || !JS_IsNumber (b)) {
            return false;
        }
        double lhs = 0, rhs = 0;
        JS_ToFloat64 (ctx, &lhs, a);
        JS_ToFloat64 (ctx, &rhs, b);
        return lhs == rhs;
    }
    if (JS_IsString (a) || JS_IsString (b)) {
        return JS_IsString (a) && JS_IsString (b) &&
        js_to_string (ctx, a) == js_to_string (ctx, b);
    }
    if (JS_IsBool (a) || JS_IsBool (b)) {
        return JS_IsBool (a) && JS_IsBool (b) && JS_ToBool (ctx, a) == JS_ToBool (ctx, b);
    }
    if (JS_IsNull (a) || JS_IsNull (b)) {
        return JS_IsNull (a) && JS_IsNull (b);
    }
    if (JS_IsUndefined (a) || JS_IsUndefined (b)) {
        return JS_IsUndefined (a) && JS_IsUndefined (b);
    }
    // Objects, functions and symbols: reference identity.
    return JS_VALUE_GET_TAG (a) == JS_VALUE_GET_TAG (b) &&
    JS_VALUE_GET_PTR (a) == JS_VALUE_GET_PTR (b);
}

// JSON form of a value, empty when it is not serialisable.
std::string js_to_json (JSContext* ctx, JSValueConst val) {
    JSValue json = JS_JSONStringify (ctx, val, JS_UNDEFINED, JS_UNDEFINED);
    std::string out;
    if (!JS_IsException (json) && JS_IsString (json)) {
        out = js_to_string (ctx, json);
    }
    JS_FreeValue (ctx, json);
    return out;
}

// The internal class of an object as `Object.prototype.toString` reports it
// ("[object Date]"). The deep compare needs it because a `Date` or a `Map`
// keeps its contents outside the own-property list, so comparing enumerable
// keys alone would report every pair of them equal. `JS_IsDate` / `JS_IsRegExp`
// exist only in quickjs-ng, so this asks the language instead of the C API.
//
// `failed`, when given, is set if the call threw and the exception was left
// pending for the caller. That distinction matters: an empty tag is otherwise
// indistinguishable from "a class this does not recognise", and a caller that
// cannot tell them apart will report a *result* for a comparison that never
// happened. See js_deep_equal, where exactly that turned a thrown error into a
// silent "not equal" on one platform (#959).
std::string js_class_tag (JSContext* ctx, JSValueConst val, bool* failed = nullptr) {
    if (failed) {
        *failed = false;
    }
    JSValue global    = JS_GetGlobalObject (ctx);
    JSValue ctor      = JS_GetPropertyStr (ctx, global, "Object");
    JSValue proto     = JS_GetPropertyStr (ctx, ctor, "prototype");
    JSValue to_string = JS_GetPropertyStr (ctx, proto, "toString");

    std::string tag;
    if (JS_IsFunction (ctx, to_string)) {
        JSValue result = JS_Call (ctx, to_string, val, 0, nullptr);
        if (!JS_IsException (result)) {
            tag = js_to_string (ctx, result);
        } else if (failed) {
            // Leave the exception pending - the caller propagates it.
            *failed = true;
        } else {
            JS_FreeValue (ctx, JS_GetException (ctx));
        }
        JS_FreeValue (ctx, result);
    }

    JS_FreeValue (ctx, to_string);
    JS_FreeValue (ctx, proto);
    JS_FreeValue (ctx, ctor);
    JS_FreeValue (ctx, global);
    return tag;
}

// How a value reads in an assertion failure. `JS_ToCString` renders every
// object as "[object Object]", which tells the script author nothing about
// which key differed; JSON is what they wrote. A RegExp is the exception -
// JSON renders one as "{}", while its own toString is the pattern.
std::string js_describe (JSContext* ctx, JSValueConst val) {
    if (JS_IsString (val)) {
        return "'" + js_to_string (ctx, val) + "'";
    }
    if (JS_IsObject (val) && !JS_IsFunction (ctx, val) &&
    js_class_tag (ctx, val) != "[object RegExp]") {
        const std::string json = js_to_json (ctx, val);
        if (!json.empty ()) {
            return json;
        }
    }
    return js_to_string (ctx, val);
}

// A cyclic structure would recurse forever. Two things stop it.
//
// The **cycle check** is the real one: js_deep_equal carries the pair of
// objects at each level of the current path, and a pair it is already
// comparing is a cycle by definition. That reports at the depth the cycle
// actually closes - depth 1 for `a.self = a` - rather than after an arbitrary
// number of levels.
//
// The **depth cap** stays as a backstop for a structure that is merely
// enormous rather than cyclic. Nothing a script asserts on legitimately nests
// this far.
//
// The cap alone used to be the whole mechanism, and #959 is why it is not any
// more: it only bounds the C recursion *after* the fact, and 64 frames of this
// function is a different amount of stack on every toolchain. On MSVC at /Od
// with AddressSanitizer's redzones the frames are fat enough that QuickJS's
// own 256 KB stack guard tripped first, inside the JS_Call in js_class_tag -
// which returned an empty tag, compared equal to the other empty tag, and fell
// through to "a class I do not recognise" and a plain `return 0`. The pending
// stack-overflow error was dropped and the caller reported an ordinary
// "not deeply equal". Same source, same input, a different answer per
// platform. Detecting the cycle where it closes means the cyclic case never
// recurses deeply on any toolchain, so the result no longer depends on frame
// size.
constexpr int kDeepEqualMaxDepth = 64;

// One level of the comparison path: the two objects being compared. Compared
// by identity, which is what a cycle is.
using DeepEqualPath = std::vector<std::pair<void*, void*>>;

// Own enumerable string-keyed property names, in insertion order.
bool js_own_enumerable_keys (JSContext* ctx, JSValueConst obj, std::vector<std::string>& out) {
    JSPropertyEnum* tab = nullptr;
    uint32_t count      = 0;
    if (JS_GetOwnPropertyNames (
        ctx, &tab, &count, obj, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
        return false;
    }
    out.clear ();
    out.reserve (count);
    for (uint32_t i = 0; i < count; i++) {
        const char* name = JS_AtomToCString (ctx, tab[i].atom);
        out.emplace_back (name ? name : "");
        JS_FreeCString (ctx, name);
        JS_FreeAtom (ctx, tab[i].atom);
    }
    js_free (ctx, tab);
    return true;
}

// Deep structural equality. Returns 1 (equal), 0 (not equal) or -1 with a
// pending exception, following the QuickJS convention.
//
// This deliberately does not go through `JSON.stringify`, which the previous
// implementation used: stringify is key-order sensitive ({a:1,b:2} vs {b:2,a:1}
// compare unequal), silently drops `undefined` members, and cannot see a value
// it fails to serialise.
int js_deep_equal (JSContext* ctx, JSValueConst a, JSValueConst b, int depth, DeepEqualPath& path) {
    if (depth > kDeepEqualMaxDepth) {
        JS_ThrowRangeError (ctx,
        "deep equality gave up after %d levels - the compared values are "
        "cyclic "
        "or too deeply nested",
        kDeepEqualMaxDepth);
        return -1;
    }

    if (js_strict_equal (ctx, a, b)) {
        return 1;
    }

    // Two NaNs are strictly unequal but deeply equal, as in chai.
    if (JS_IsNumber (a) && JS_IsNumber (b)) {
        double lhs = 0, rhs = 0;
        JS_ToFloat64 (ctx, &lhs, a);
        JS_ToFloat64 (ctx, &rhs, b);
        return (std::isnan (lhs) && std::isnan (rhs)) ? 1 : 0;
    }

    // A primitive that is not strictly equal is never deeply equal, and a
    // primitive never equals an object (`null` vs `undefined` included).
    if (!JS_IsObject (a) || !JS_IsObject (b)) {
        return 0;
    }
    // Functions compare by reference only, which strict equality already ruled
    // out above.
    if (JS_IsFunction (ctx, a) || JS_IsFunction (ctx, b)) {
        return 0;
    }

    // Both objects, and neither is a function: this is the point the walk can
    // revisit a pair it is already comparing, which is what a cycle is.
    void* const a_id = JS_VALUE_GET_PTR (a);
    void* const b_id = JS_VALUE_GET_PTR (b);
    for (const auto& seen : path) {
        if (seen.first == a_id && seen.second == b_id) {
            JS_ThrowRangeError (ctx,
            "deep equality cannot compare cyclic values - the same pair of "
            "objects appears twice on one path");
            return -1;
        }
    }

    bool tag_failed       = false;
    const std::string tag = js_class_tag (ctx, a, &tag_failed);
    if (tag_failed) {
        return -1;
    }
    const std::string b_tag = js_class_tag (ctx, b, &tag_failed);
    if (tag_failed) {
        return -1;
    }
    if (tag != b_tag) {
        return 0;
    }
    if (tag == "[object Date]") {
        // JSON renders a Date as its ISO instant, which is the comparison chai
        // makes (and keeps millisecond resolution, unlike toString).
        return js_to_json (ctx, a) == js_to_json (ctx, b) ? 1 : 0;
    }
    if (tag == "[object RegExp]") {
        return js_to_string (ctx, a) == js_to_string (ctx, b) ? 1 : 0;
    }
    if (tag != "[object Object]" && tag != "[object Array]" && tag != "[object Error]") {
        // Map, Set, typed arrays and the like hold their contents somewhere a
        // structural compare cannot see, so every pair would look equal. Report
        // unequal rather than pass silently; reference identity already matched
        // the only case that is certainly equal.
        return 0;
    }

    if (tag == "[object Array]") {
        JSValue a_len_val = JS_GetPropertyStr (ctx, a, "length");
        JSValue b_len_val = JS_GetPropertyStr (ctx, b, "length");
        uint32_t a_len = 0, b_len = 0;
        JS_ToUint32 (ctx, &a_len, a_len_val);
        JS_ToUint32 (ctx, &b_len, b_len_val);
        JS_FreeValue (ctx, a_len_val);
        JS_FreeValue (ctx, b_len_val);
        if (a_len != b_len) {
            return 0;
        }
        for (uint32_t i = 0; i < a_len; i++) {
            JSValue a_elem = JS_GetPropertyUint32 (ctx, a, i);
            JSValue b_elem = JS_GetPropertyUint32 (ctx, b, i);
            path.emplace_back (a_id, b_id);
            const int same = js_deep_equal (ctx, a_elem, b_elem, depth + 1, path);
            path.pop_back ();
            JS_FreeValue (ctx, a_elem);
            JS_FreeValue (ctx, b_elem);
            if (same != 1) {
                return same;
            }
        }
        return 1;
    }

    std::vector<std::string> a_keys, b_keys;
    if (!js_own_enumerable_keys (ctx, a, a_keys) || !js_own_enumerable_keys (ctx, b, b_keys)) {
        return -1;
    }
    if (a_keys.size () != b_keys.size ()) {
        return 0;
    }
    // Equal sizes plus every key of `a` present in `b` means the key sets are
    // identical, so order never enters the comparison.
    for (const auto& key : a_keys) {
        if (std::find (b_keys.begin (), b_keys.end (), key) == b_keys.end ()) {
            return 0;
        }
        JSValue a_val = JS_GetPropertyStr (ctx, a, key.c_str ());
        JSValue b_val = JS_GetPropertyStr (ctx, b, key.c_str ());
        path.emplace_back (a_id, b_id);
        const int same = js_deep_equal (ctx, a_val, b_val, depth + 1, path);
        path.pop_back ();
        JS_FreeValue (ctx, a_val);
        JS_FreeValue (ctx, b_val);
        if (same != 1) {
            return same;
        }
    }
    return 1;
}

// Compares by whichever rule the chain asked for: `deep` when a `deep` /
// `eql` chain set it, strict otherwise. -1 signals a pending exception.
int js_compare_for_chain (JSContext* ctx, JSValueConst a, JSValueConst b, bool deep) {
    if (!deep) {
        return js_strict_equal (ctx, a, b) ? 1 : 0;
    }
    DeepEqualPath path;
    return js_deep_equal (ctx, a, b, 0, path);
}

JSValue expect_to_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    // "to" just returns this for chaining
    return JS_DupValue (ctx, this_val);
}

/**
 * `.not` - negate the rest of this chain.
 *
 * A **set**, not a toggle, which is chai's own rule
 * (`flag(this, 'negate', true)`) and the only one that survives a chain with
 * more than one `.not` in it (issue #883). Toggling made every even-numbered
 * `.not` cancel the one before it, so
 * `expect(x).to.not.include("+").and.to.not.include("/")` asserted that x
 * *does* include "/" - silently, and in whichever direction the author's count
 * of `.not`s happened to fall. Nothing resets the flag between assertions in a
 * chain, so a second `.not` has to be a no-op rather than an inversion.
 */
JSValue expect_not_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (state) {
        state->negated = true;
    }
    return JS_DupValue (ctx, this_val);
}

JSValue expect_be_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    return JS_DupValue (ctx, this_val);
}

// `deep` and `nested` are flag-setting chainers: they change what the matcher
// at the end of the chain compares, then hand the same expectation back.
JSValue expect_deep_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (state) {
        state->deep = true;
    }
    return JS_DupValue (ctx, this_val);
}

JSValue expect_nested_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (state) {
        state->nested = true;
    }
    return JS_DupValue (ctx, this_val);
}

// Every callable matcher returns the expectation rather than `undefined`, which
// is what makes `.and` work: it is a plain passthrough, and the flags a chain
// has set (`not` included) persist across it exactly as they do in chai.
JSValue expect_chained (JSContext* ctx, JSValueConst this_val) {
    return JS_DupValue (ctx, this_val);
}

// Shared body of `equal` and `eql`. `always_deep` is what separates them: `eql`
// is deep whatever the chain said, `equal` is strict unless `deep` set the flag.
JSValue
expect_equality (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, bool always_deep) {
    if (argc < 1) {
        return JS_ThrowTypeError (
        ctx, "%s() requires an argument", always_deep ? "eql" : "equal");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const bool deep = always_deep || state->deep;
    const int same  = js_compare_for_chain (ctx, state->actual, argv[0], deep);
    if (same < 0) {
        return JS_EXCEPTION;
    }

    const bool pass = state->negated ? (same == 0) : (same == 1);
    if (!pass) {
        const std::string relation = std::string (state->negated ? " to not " : " to ") +
        (deep ? "deeply equal " : "equal ");
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        relation + js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_equal (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    return expect_equality (ctx, this_val, argc, argv, false);
}

JSValue expect_eql (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    return expect_equality (ctx, this_val, argc, argv, true);
}

JSValue expect_exist (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool exists = !JS_IsUndefined (state->actual) && !JS_IsNull (state->actual);
    bool pass   = state->negated ? !exists : exists;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not exist" :
                                           "Expected value to exist";
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_true (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool is_true = JS_ToBool (ctx, state->actual) == 1;
    bool pass    = state->negated ? !is_true : is_true;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to be falsy" :
                                           "Expected value to be truthy";
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_false (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool is_false = JS_ToBool (ctx, state->actual) == 0;
    bool pass     = state->negated ? !is_false : is_false;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not be false" :
                                           "Expected value to be false";
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_above (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "above() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double actual, expected;
    if (JS_ToFloat64 (ctx, &actual, state->actual) < 0 ||
    JS_ToFloat64 (ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "above() requires numeric values");
    }

    bool above = actual > expected;
    bool pass  = state->negated ? !above : above;

    if (!pass) {
        std::string msg = state->negated ? "Expected " + std::to_string (actual) +
        " to not be above " + std::to_string (expected) :
                                           "Expected " +
        std::to_string (actual) + " to be above " + std::to_string (expected);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_below (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "below() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double actual, expected;
    if (JS_ToFloat64 (ctx, &actual, state->actual) < 0 ||
    JS_ToFloat64 (ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "below() requires numeric values");
    }

    bool below = actual < expected;
    bool pass  = state->negated ? !below : below;

    if (!pass) {
        std::string msg = state->negated ? "Expected " + std::to_string (actual) +
        " to not be below " + std::to_string (expected) :
                                           "Expected " +
        std::to_string (actual) + " to be below " + std::to_string (expected);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_include (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "include() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool includes = false;

    // A Url object takes the substring branch, not the "neither string nor
    // array" one that answers false. `pm.expect(pm.request.url).to.include(...)`
    // is the idiom in this repo's own docs and tests, and #991 turned its
    // target from a string into an object - a verdict that silently flipped to
    // failing is the worst thing an assertion can do.
    RequestUrlState* url = request_url_state (state->actual);

    if (JS_IsString (state->actual) || url != nullptr) {
        const std::string str = url != nullptr ?
        request_url_current_text (ctx, state->actual, *url) :
        js_to_string (ctx, state->actual);
        std::string substr    = js_to_string (ctx, argv[0]);
        includes              = str.find (substr) != std::string::npos;
    } else if (JS_IsArray (state->actual)) {
        JSValue length = JS_GetPropertyStr (ctx, state->actual, "length");
        uint32_t len;
        JS_ToUint32 (ctx, &len, length);
        JS_FreeValue (ctx, length);

        // Membership follows the chain's comparison rule. It used to compare
        // `JS_ToCString` forms, under which every object member matched every
        // object needle - both render as "[object Object]".
        for (uint32_t i = 0; i < len && !includes; i++) {
            JSValue elem = JS_GetPropertyUint32 (ctx, state->actual, i);
            const int same = js_compare_for_chain (ctx, elem, argv[0], state->deep);
            JS_FreeValue (ctx, elem);
            if (same < 0) {
                return JS_EXCEPTION;
            }
            includes = (same == 1);
        }
    }

    bool pass = state->negated ? !includes : includes;

    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not include " : " to include ") +
        js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// Splits a `nested.property` path into its segments: "a.b[0].c" walks a, b, 0,
// c. Chai's escape form (`a\.b` for a literal dot) is not supported; a path is
// read left to right and a `[` opens an index.
std::vector<std::string> split_property_path (const std::string& path) {
    std::vector<std::string> segments;
    std::string current;
    for (const char ch : path) {
        if (ch == '.' || ch == '[') {
            if (!current.empty ()) {
                segments.push_back (current);
                current.clear ();
            }
        } else if (ch == ']') {
            if (!current.empty ()) {
                segments.push_back (current);
                current.clear ();
            }
        } else {
            current.push_back (ch);
        }
    }
    if (!current.empty ()) {
        segments.push_back (current);
    }
    return segments;
}

JSValue expect_have_property (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "property() requires a property name");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const std::string prop_name             = js_to_string (ctx, argv[0]);
    const std::vector<std::string> segments = state->nested ?
    split_property_path (prop_name) :
    std::vector<std::string>{ prop_name };
    if (segments.empty ()) {
        return JS_ThrowTypeError (ctx, "property() requires a property name");
    }

    // Walk to the parent of the last segment, so a missing intermediate is a
    // missing property rather than a thrown "cannot read property of
    // undefined". A plain (non-nested) chain has exactly one segment.
    JSValue holder = JS_DupValue (ctx, state->actual);
    bool has_prop  = true;
    for (size_t i = 0; i + 1 < segments.size (); i++) {
        if (!JS_IsObject (holder)) {
            has_prop = false;
            break;
        }
        JSValue next = JS_GetPropertyStr (ctx, holder, segments[i].c_str ());
        JS_FreeValue (ctx, holder);
        holder = next;
    }

    if (has_prop) {
        if (!JS_IsObject (holder)) {
            has_prop = false;
        } else {
            JSAtom atom = JS_NewAtom (ctx, segments.back ().c_str ());
            has_prop    = JS_HasProperty (ctx, holder, atom) == 1;
            JS_FreeAtom (ctx, atom);
        }
    }

    // A second argument also checks the value. Chai compares it strictly unless
    // the chain is `deep`, which is why this cannot stringify: two objects with
    // the same JSON are still different references.
    if (has_prop && argc >= 2) {
        JSValue actual_val = JS_GetPropertyStr (ctx, holder, segments.back ().c_str ());
        const int same = js_compare_for_chain (ctx, actual_val, argv[1], state->deep);
        JS_FreeValue (ctx, actual_val);
        if (same < 0) {
            JS_FreeValue (ctx, holder);
            return JS_EXCEPTION;
        }
        has_prop = (same == 1);
    }
    JS_FreeValue (ctx, holder);

    bool pass = state->negated ? !has_prop : has_prop;

    if (!pass) {
        std::string msg = state->negated ?
        "Expected object to not have property '" + prop_name + "'" :
        "Expected object to have property '" + prop_name + "'";
        if (argc >= 2) {
            msg += " equal to " + js_describe (ctx, argv[1]);
        }
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// Terminal getters: assert on property access (Chai/Postman paren-less idiom).
// Each honors the tracked `negated` flag, throws on failure, and returns the
// expectation object so a chain can continue.

JSValue expect_null_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool is_null = JS_IsNull (state->actual);
    bool pass    = state->negated ? !is_null : is_null;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not be null" :
                                           "Expected value to be null";
        return throw_expect_failure (ctx, state, msg);
    }

    return JS_DupValue (ctx, this_val);
}

JSValue expect_undefined_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool is_undef = JS_IsUndefined (state->actual);
    bool pass     = state->negated ? !is_undef : is_undef;

    if (!pass) {
        const char* msg = state->negated ?
        "Expected value to not be undefined" :
        "Expected value to be undefined";
        return throw_expect_failure (ctx, state, msg);
    }

    return JS_DupValue (ctx, this_val);
}

JSValue expect_ok_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool is_ok = JS_ToBool (ctx, state->actual) == 1;
    bool pass  = state->negated ? !is_ok : is_ok;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not be truthy" :
                                           "Expected value to be truthy";
        return throw_expect_failure (ctx, state, msg);
    }

    return JS_DupValue (ctx, this_val);
}

JSValue expect_empty_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool is_empty = false;
    if (JS_IsString (state->actual)) {
        is_empty = js_to_string (ctx, state->actual).empty ();
    } else if (JS_IsArray (state->actual)) {
        JSValue length = JS_GetPropertyStr (ctx, state->actual, "length");
        uint32_t len   = 0;
        JS_ToUint32 (ctx, &len, length);
        JS_FreeValue (ctx, length);
        is_empty = (len == 0);
    } else if (JS_IsObject (state->actual)) {
        JSPropertyEnum* tab = nullptr;
        uint32_t count      = 0;
        if (JS_GetOwnPropertyNames (ctx, &tab, &count, state->actual,
            JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
            is_empty = (count == 0);
            for (uint32_t i = 0; i < count; i++) {
                JS_FreeAtom (ctx, tab[i].atom);
            }
            js_free (ctx, tab);
        }
    }

    bool pass = state->negated ? !is_empty : is_empty;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not be empty" :
                                           "Expected value to be empty";
        return throw_expect_failure (ctx, state, msg);
    }

    return JS_DupValue (ctx, this_val);
}

// Callable matchers documented in pm-api-compatibility.md but previously absent.

JSValue expect_least (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "least() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double actual, expected;
    if (JS_ToFloat64 (ctx, &actual, state->actual) < 0 ||
    JS_ToFloat64 (ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "least() requires numeric values");
    }

    bool at_least = actual >= expected;
    bool pass     = state->negated ? !at_least : at_least;

    if (!pass) {
        std::string msg = "Expected " + std::to_string (actual) +
        (state->negated ? " to not be at least " : " to be at least ") +
        std::to_string (expected);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_most (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "most() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double actual, expected;
    if (JS_ToFloat64 (ctx, &actual, state->actual) < 0 ||
    JS_ToFloat64 (ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "most() requires numeric values");
    }

    bool at_most = actual <= expected;
    bool pass    = state->negated ? !at_most : at_most;

    if (!pass) {
        std::string msg = "Expected " + std::to_string (actual) +
        (state->negated ? " to not be at most " : " to be at most ") +
        std::to_string (expected);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_length (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "length() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    JSValue length_val = JS_GetPropertyStr (ctx, state->actual, "length");
    if (JS_IsUndefined (length_val)) {
        JS_FreeValue (ctx, length_val);
        return JS_ThrowTypeError (ctx, "length() requires a value with a length");
    }

    double actual_len, expected;
    JS_ToFloat64 (ctx, &actual_len, length_val);
    JS_FreeValue (ctx, length_val);
    if (JS_ToFloat64 (ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "length() requires a numeric argument");
    }

    bool matches = (actual_len == expected);
    bool pass    = state->negated ? !matches : matches;

    if (!pass) {
        std::string msg = "Expected length " + std::to_string (actual_len) +
        (state->negated ? " to not equal " : " to equal ") + std::to_string (expected);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_a (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "a() requires a type name");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    std::string type_name;
    if (JS_IsNull (state->actual)) {
        type_name = "null";
    } else if (JS_IsUndefined (state->actual)) {
        type_name = "undefined";
    } else if (JS_IsArray (state->actual)) {
        type_name = "array";
    } else if (JS_IsString (state->actual)) {
        type_name = "string";
    } else if (JS_IsNumber (state->actual)) {
        type_name = "number";
    } else if (JS_IsBool (state->actual)) {
        type_name = "boolean";
    } else if (JS_IsFunction (ctx, state->actual)) {
        type_name = "function";
    } else if (JS_IsObject (state->actual)) {
        type_name = "object";
    } else {
        type_name = "undefined";
    }

    std::string expected = js_to_string (ctx, argv[0]);
    for (auto& c : expected) {
        c = static_cast<char> (std::tolower (static_cast<unsigned char> (c)));
    }

    bool matches = (type_name == expected);
    bool pass    = state->negated ? !matches : matches;

    if (!pass) {
        std::string msg = "Expected type " + type_name +
        (state->negated ? " to not be " : " to be ") + expected;
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_match (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "match() requires a regular expression");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    JSValue test_fn = JS_GetPropertyStr (ctx, argv[0], "test");
    if (!JS_IsFunction (ctx, test_fn)) {
        JS_FreeValue (ctx, test_fn);
        return JS_ThrowTypeError (ctx, "match() requires a regular expression");
    }

    std::string subject = js_to_string (ctx, state->actual);
    JSValue arg         = JS_NewString (ctx, subject.c_str ());
    JSValue result      = JS_Call (ctx, test_fn, argv[0], 1, &arg);
    JS_FreeValue (ctx, arg);
    JS_FreeValue (ctx, test_fn);

    if (JS_IsException (result)) {
        JS_FreeValue (ctx, result);
        return JS_EXCEPTION;
    }

    bool matched = JS_ToBool (ctx, result) == 1;
    JS_FreeValue (ctx, result);
    bool pass = state->negated ? !matched : matched;

    if (!pass) {
        std::string msg = state->negated ?
        "Expected '" + subject + "' to not match the pattern" :
        "Expected '" + subject + "' to match the pattern";
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// Matchers a Postman suite reaches for that used to throw "not a function".
// Each one fails loudly on an argument it cannot use, because a matcher that
// quietly accepts anything is the false-pass this series exists to remove.

JSValue expect_one_of (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsArray (argv[0])) {
        return JS_ThrowTypeError (ctx, "oneOf() requires an array of candidates");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    JSValue length_val = JS_GetPropertyStr (ctx, argv[0], "length");
    uint32_t len       = 0;
    JS_ToUint32 (ctx, &len, length_val);
    JS_FreeValue (ctx, length_val);

    bool found = false;
    for (uint32_t i = 0; i < len && !found; i++) {
        JSValue candidate = JS_GetPropertyUint32 (ctx, argv[0], i);
        const int same =
        js_compare_for_chain (ctx, state->actual, candidate, state->deep);
        JS_FreeValue (ctx, candidate);
        if (same < 0) {
            return JS_EXCEPTION;
        }
        found = (same == 1);
    }

    const bool pass = state->negated ? !found : found;
    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be one of " : " to be one of ") +
        js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// `have.keys` in chai means "exactly these keys". The subset form
// (`include.keys`) is not supported; see pm-api-compatibility.md.
JSValue expect_keys (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "keys() requires at least one key name");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsObject (state->actual)) {
        return JS_ThrowTypeError (ctx, "keys() requires an object or array");
    }

    std::vector<std::string> expected;
    if (argc == 1 && JS_IsArray (argv[0])) {
        JSValue length_val = JS_GetPropertyStr (ctx, argv[0], "length");
        uint32_t len       = 0;
        JS_ToUint32 (ctx, &len, length_val);
        JS_FreeValue (ctx, length_val);
        for (uint32_t i = 0; i < len; i++) {
            JSValue key = JS_GetPropertyUint32 (ctx, argv[0], i);
            expected.push_back (js_to_string (ctx, key));
            JS_FreeValue (ctx, key);
        }
    } else {
        for (int i = 0; i < argc; i++) {
            expected.push_back (js_to_string (ctx, argv[i]));
        }
    }
    std::sort (expected.begin (), expected.end ());
    expected.erase (std::unique (expected.begin (), expected.end ()), expected.end ());

    std::vector<std::string> actual_keys;
    if (!js_own_enumerable_keys (ctx, state->actual, actual_keys)) {
        return JS_EXCEPTION;
    }
    std::sort (actual_keys.begin (), actual_keys.end ());

    const bool matches = (actual_keys == expected);
    const bool pass    = state->negated ? !matches : matches;
    if (!pass) {
        std::string listed;
        for (const auto& key : expected) {
            listed += (listed.empty () ? "" : ", ") + std::string ("'") + key + "'";
        }
        const std::string msg = std::string ("Expected object to ") +
        (state->negated ? "not have" : "have") + " exactly the keys " + listed;
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_members (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsArray (argv[0])) {
        return JS_ThrowTypeError (ctx, "members() requires an array");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsArray (state->actual)) {
        return JS_ThrowTypeError (ctx, "members() requires the target to be an array");
    }

    const auto array_length = [ctx] (JSValueConst array) {
        JSValue length_val = JS_GetPropertyStr (ctx, array, "length");
        uint32_t len       = 0;
        JS_ToUint32 (ctx, &len, length_val);
        JS_FreeValue (ctx, length_val);
        return len;
    };

    const uint32_t actual_len   = array_length (state->actual);
    const uint32_t expected_len = array_length (argv[0]);

    // Same members in any order: pair each expected element with an unused
    // actual element, so duplicates have to match in count too.
    bool matches = (actual_len == expected_len);
    std::vector<bool> claimed (actual_len, false);
    for (uint32_t i = 0; i < expected_len && matches; i++) {
        JSValue wanted = JS_GetPropertyUint32 (ctx, argv[0], i);
        bool paired    = false;
        for (uint32_t j = 0; j < actual_len && !paired; j++) {
            if (claimed[j]) {
                continue;
            }
            JSValue candidate = JS_GetPropertyUint32 (ctx, state->actual, j);
            const int same = js_compare_for_chain (ctx, candidate, wanted, state->deep);
            JS_FreeValue (ctx, candidate);
            if (same < 0) {
                JS_FreeValue (ctx, wanted);
                return JS_EXCEPTION;
            }
            if (same == 1) {
                claimed[j] = true;
                paired     = true;
            }
        }
        JS_FreeValue (ctx, wanted);
        matches = paired;
    }

    const bool pass = state->negated ? !matches : matches;
    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not have members " : " to have members ") +
        js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_throw (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsFunction (ctx, state->actual)) {
        return JS_ThrowTypeError (ctx, "throw() requires the target to be a function");
    }

    JSValue result   = JS_Call (ctx, state->actual, JS_UNDEFINED, 0, nullptr);
    const bool threw = JS_IsException (result);
    std::string thrown;
    if (threw) {
        JSValue exc = JS_GetException (ctx);
        thrown      = js_to_string (ctx, exc);
        JS_FreeValue (ctx, exc);
    }
    JS_FreeValue (ctx, result);

    bool matches = threw;
    if (threw && argc >= 1 && !JS_IsUndefined (argv[0])) {
        if (JS_IsString (argv[0])) {
            matches = thrown.find (js_to_string (ctx, argv[0])) != std::string::npos;
        } else {
            JSValue test_fn = JS_GetPropertyStr (ctx, argv[0], "test");
            if (!JS_IsFunction (ctx, test_fn)) {
                JS_FreeValue (ctx, test_fn);
                return JS_ThrowTypeError (ctx,
                "throw() accepts a message substring or a regular expression");
            }
            JSValue subject = JS_NewString (ctx, thrown.c_str ());
            JSValue tested  = JS_Call (ctx, test_fn, argv[0], 1, &subject);
            JS_FreeValue (ctx, subject);
            JS_FreeValue (ctx, test_fn);
            if (JS_IsException (tested)) {
                JS_FreeValue (ctx, tested);
                return JS_EXCEPTION;
            }
            matches = JS_ToBool (ctx, tested) == 1;
            JS_FreeValue (ctx, tested);
        }
    }

    const bool pass = state->negated ? !matches : matches;
    if (!pass) {
        std::string msg = state->negated ?
        "Expected the function to not throw" :
        "Expected the function to throw";
        if (threw) {
            msg += ", but it threw " + thrown;
        }
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_instance_of (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "instanceOf() requires a constructor");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const int is_instance = JS_IsInstanceOf (ctx, state->actual, argv[0]);
    if (is_instance < 0) {
        return JS_EXCEPTION;
    }

    const bool pass = state->negated ? (is_instance == 0) : (is_instance == 1);
    if (!pass) {
        JSValue name_val            = JS_GetPropertyStr (ctx, argv[0], "name");
        const std::string ctor_name = js_to_string (ctx, name_val);
        JS_FreeValue (ctx, name_val);
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be an instance of " : " to be an instance of ") + ctor_name;
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_close_to (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 2) {
        return JS_ThrowTypeError (ctx, "closeTo() requires an expected value and a delta");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double actual = 0, expected = 0, delta = 0;
    if (JS_ToFloat64 (ctx, &actual, state->actual) < 0 ||
    JS_ToFloat64 (ctx, &expected, argv[0]) < 0 ||
    JS_ToFloat64 (ctx, &delta, argv[1]) < 0) {
        return JS_ThrowTypeError (ctx, "closeTo() requires numeric values");
    }
    if (std::isnan (actual) || std::isnan (expected) || std::isnan (delta)) {
        return JS_ThrowTypeError (ctx, "closeTo() requires numeric values");
    }

    const bool close = std::fabs (actual - expected) <= delta;
    const bool pass  = state->negated ? !close : close;
    if (!pass) {
        const std::string msg = "Expected " + std::to_string (actual) +
        (state->negated ? " to not be within " : " to be within ") +
        std::to_string (delta) + " of " + std::to_string (expected);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_satisfy (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "satisfy() requires a predicate function");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    JSValue arg    = JS_DupValue (ctx, state->actual);
    JSValue result = JS_Call (ctx, argv[0], JS_UNDEFINED, 1, &arg);
    JS_FreeValue (ctx, arg);
    if (JS_IsException (result)) {
        JS_FreeValue (ctx, result);
        return JS_EXCEPTION;
    }
    const bool satisfied = JS_ToBool (ctx, result) == 1;
    JS_FreeValue (ctx, result);

    const bool pass = state->negated ? !satisfied : satisfied;
    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not satisfy the predicate" : " to satisfy the predicate");
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// chai's `.to.have.string(sub)`: a substring assertion that, unlike `include`,
// refuses a non-string target instead of reporting "does not include".
JSValue expect_string (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "string() requires a substring");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsString (state->actual)) {
        return JS_ThrowTypeError (ctx, "string() requires the target to be a string");
    }

    const std::string subject = js_to_string (ctx, state->actual);
    const std::string needle  = js_to_string (ctx, argv[0]);
    const bool contains       = subject.find (needle) != std::string::npos;
    const bool pass           = state->negated ? !contains : contains;
    if (!pass) {
        const std::string msg = "Expected '" + subject +
        (state->negated ? "' to not contain '" : "' to contain '") + needle + "'";
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue create_expectation (JSContext* ctx, JSValue actual, std::string message) {
    JSValue obj = JS_NewObjectClass (ctx, expect_class_id);
    if (JS_IsException (obj)) {
        return obj;
    }

    auto* state    = new ExpectState{ JS_DupValue (ctx, actual), false };
    state->message = std::move (message);
    JS_SetOpaque (obj, state);

    // Add "to" getter for chaining
    JSAtom to_atom = JS_NewAtom (ctx, "to");
    JS_DefinePropertyGetSet (ctx, obj, to_atom,
    JS_NewCFunction (ctx, expect_to_getter, "to", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, to_atom);

    // Add "not" getter for negation
    JSAtom not_atom = JS_NewAtom (ctx, "not");
    JS_DefinePropertyGetSet (ctx, obj, not_atom,
    JS_NewCFunction (ctx, expect_not_getter, "not", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, not_atom);

    // Add "be" getter for chaining
    JSAtom be_atom = JS_NewAtom (ctx, "be");
    JS_DefinePropertyGetSet (ctx, obj, be_atom,
    JS_NewCFunction (ctx, expect_be_getter, "be", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, be_atom);

    // Add "have" getter for chaining (same as "to")
    JSAtom have_atom = JS_NewAtom (ctx, "have");
    JS_DefinePropertyGetSet (ctx, obj, have_atom,
    JS_NewCFunction (ctx, expect_to_getter, "have", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, have_atom);

    // Add "at" getter for chaining (for `.at.least(n)` / `.at.most(n)`)
    JSAtom at_atom = JS_NewAtom (ctx, "at");
    JS_DefinePropertyGetSet (ctx, obj, at_atom,
    JS_NewCFunction (ctx, expect_to_getter, "at", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, at_atom);

    // Passthrough chainers. "and" continues a chain after a matcher (which is
    // why every matcher returns the expectation), and "all" is chai's default
    // quantifier for `.keys`, so it changes nothing - `.any` is deliberately
    // absent rather than aliased to `all`, which would silently assert more
    // than the script asked.
    const char* passthrough_chainers[] = { "and", "all" };
    for (const char* name : passthrough_chainers) {
        JSAtom atom = JS_NewAtom (ctx, name);
        JS_DefinePropertyGetSet (ctx, obj, atom,
        JS_NewCFunction (ctx, expect_to_getter, name, 0), JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    }

    // Flag-setting chainers.
    JSAtom deep_atom = JS_NewAtom (ctx, "deep");
    JS_DefinePropertyGetSet (ctx, obj, deep_atom,
    JS_NewCFunction (ctx, expect_deep_getter, "deep", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, deep_atom);

    JSAtom nested_atom = JS_NewAtom (ctx, "nested");
    JS_DefinePropertyGetSet (ctx, obj, nested_atom,
    JS_NewCFunction (ctx, expect_nested_getter, "nested", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, nested_atom);

    // Terminal matchers assert on access (Chai/Postman paren-less idiom), so
    // register them as getters rather than function-valued properties - a bare
    // `.to.be.true` must run the check, not silently return an uncalled function.
    struct TerminalGetter {
        const char* name;
        JSCFunction* fn;
    };
    const TerminalGetter terminals[] = { { "exist", expect_exist },
        { "true", expect_true }, { "false", expect_false },
        { "null", expect_null_getter }, { "undefined", expect_undefined_getter },
        { "ok", expect_ok_getter }, { "empty", expect_empty_getter } };
    for (const auto& t : terminals) {
        JSAtom atom = JS_NewAtom (ctx, t.name);
        JS_DefinePropertyGetSet (
        ctx, obj, atom, JS_NewCFunction (ctx, t.fn, t.name, 0), JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    }

    // Add callable assertion methods. `equal` and `eql` are separate functions
    // on purpose: chai's `equal` is `===` (reference identity for objects) and
    // `eql` is deep, so aliasing them passes assertions Postman fails.
    JS_SetPropertyStr (ctx, obj, "equal", JS_NewCFunction (ctx, expect_equal, "equal", 1));
    JS_SetPropertyStr (ctx, obj, "eql", JS_NewCFunction (ctx, expect_eql, "eql", 1));
    JS_SetPropertyStr (ctx, obj, "eqls", JS_NewCFunction (ctx, expect_eql, "eqls", 1));
    JS_SetPropertyStr (ctx, obj, "oneOf", JS_NewCFunction (ctx, expect_one_of, "oneOf", 1));
    JS_SetPropertyStr (ctx, obj, "keys", JS_NewCFunction (ctx, expect_keys, "keys", 1));
    JS_SetPropertyStr (ctx, obj, "key", JS_NewCFunction (ctx, expect_keys, "key", 1));
    JS_SetPropertyStr (
    ctx, obj, "members", JS_NewCFunction (ctx, expect_members, "members", 1));
    JS_SetPropertyStr (ctx, obj, "throw", JS_NewCFunction (ctx, expect_throw, "throw", 1));
    JS_SetPropertyStr (
    ctx, obj, "throws", JS_NewCFunction (ctx, expect_throw, "throws", 1));
    JS_SetPropertyStr (ctx, obj, "instanceOf",
    JS_NewCFunction (ctx, expect_instance_of, "instanceOf", 1));
    JS_SetPropertyStr (
    ctx, obj, "closeTo", JS_NewCFunction (ctx, expect_close_to, "closeTo", 2));
    JS_SetPropertyStr (
    ctx, obj, "satisfy", JS_NewCFunction (ctx, expect_satisfy, "satisfy", 1));
    JS_SetPropertyStr (
    ctx, obj, "string", JS_NewCFunction (ctx, expect_string, "string", 1));
    JS_SetPropertyStr (ctx, obj, "above", JS_NewCFunction (ctx, expect_above, "above", 1));
    JS_SetPropertyStr (ctx, obj, "below", JS_NewCFunction (ctx, expect_below, "below", 1));
    JS_SetPropertyStr (ctx, obj, "least", JS_NewCFunction (ctx, expect_least, "least", 1));
    JS_SetPropertyStr (ctx, obj, "most", JS_NewCFunction (ctx, expect_most, "most", 1));
    JS_SetPropertyStr (
    ctx, obj, "include", JS_NewCFunction (ctx, expect_include, "include", 1));
    JS_SetPropertyStr (
    ctx, obj, "contain", JS_NewCFunction (ctx, expect_include, "contain", 1));
    JS_SetPropertyStr (
    ctx, obj, "length", JS_NewCFunction (ctx, expect_length, "length", 1));
    JS_SetPropertyStr (
    ctx, obj, "lengthOf", JS_NewCFunction (ctx, expect_length, "lengthOf", 1));
    JS_SetPropertyStr (ctx, obj, "a", JS_NewCFunction (ctx, expect_a, "a", 1));
    JS_SetPropertyStr (ctx, obj, "an", JS_NewCFunction (ctx, expect_a, "an", 1));
    JS_SetPropertyStr (ctx, obj, "match", JS_NewCFunction (ctx, expect_match, "match", 1));
    JS_SetPropertyStr (ctx, obj, "property",
    JS_NewCFunction (ctx, expect_have_property, "property", 2));

    return obj;
}

// ============================================================================
// Base64 globals and pm.crypto
// ============================================================================
//
// Why this is synchronous, and why it is not called `crypto.subtle`.
//
// Web Crypto's SubtleCrypto returns Promises. `Promise` exists in this sandbox
// but nothing drains the job queue - there is no event loop and no setTimeout
// (see the timeout note on ScriptConfig) - so `await crypto.subtle.digest(...)`
// would never resume and the script would report a timeout rather than a
// result. Wearing the Web Crypto name while behaving differently is the exact
// trap the sandbox-surface tests exist to catch, so the hashing surface takes a
// name of its own, `pm.crypto`, and is honestly synchronous. `btoa` / `atob`
// keep their standard names because they are synchronous on the web too, and
// they keep their standard Latin-1 semantics with them.

// A JS string reaches C++ as UTF-8. `btoa` is defined over code units, not code
// points, so anything above U+00FF is a range error there; every other caller
// wants the UTF-8 bytes as they stand. Returning the byte string keeps one
// conversion rule in one place.
enum class ByteSource { Utf8, Latin1 };

// Decodes UTF-8 to Latin-1 bytes, failing on any code point above U+00FF.
// Returns false when the string cannot be represented, leaving `out` unusable.
bool utf8_to_latin1 (std::string_view in, std::string& out) {
    out.clear ();
    out.reserve (in.size ());
    for (size_t i = 0; i < in.size ();) {
        const auto lead = static_cast<uint8_t> (in[i]);
        if (lead < 0x80) {
            out.push_back (static_cast<char> (lead));
            i += 1;
        } else if ((lead & 0xE0) == 0xC0 && i + 1 < in.size ()) {
            const auto cont = static_cast<uint8_t> (in[i + 1]);
            if ((cont & 0xC0) != 0x80)
                return false;
            const unsigned cp = ((lead & 0x1FU) << 6) | (cont & 0x3FU);
            if (cp > 0xFF)
                return false;
            out.push_back (static_cast<char> (cp));
            i += 2;
        } else {
            // Three- and four-byte sequences are all above U+00FF by
            // definition, and a malformed lead byte is not representable
            // either.
            return false;
        }
    }
    return true;
}

// Latin-1 bytes back to a JS string: each byte becomes the code point of the
// same value, which is UTF-8 encoded so QuickJS decodes it to that code unit.
std::string latin1_to_utf8 (std::string_view in) {
    std::string out;
    out.reserve (in.size ());
    for (const char ch : in) {
        const auto byte = static_cast<uint8_t> (ch);
        if (byte < 0x80) {
            out.push_back (static_cast<char> (byte));
        } else {
            out.push_back (static_cast<char> (0xC0 | (byte >> 6)));
            out.push_back (static_cast<char> (0x80 | (byte & 0x3F)));
        }
    }
    return out;
}

JSValue js_btoa (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "btoa requires a string");
    }
    if (!JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "btoa expects a string");
    }

    std::string bytes;
    if (!utf8_to_latin1 (js_to_string (ctx, argv[0]), bytes)) {
        return JS_ThrowTypeError (ctx,
        "btoa: the string contains characters outside the Latin-1 range. "
        "Base64 encodes bytes, so encode the text yourself first (for example "
        "with pm.crypto's digest output) or restrict it to code points <= "
        "U+00FF");
    }

    const std::string encoded = vayu::utils::base64_encode (bytes);
    return JS_NewStringLen (ctx, encoded.data (), encoded.size ());
}

JSValue js_atob (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "atob requires a string");
    }
    if (!JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "atob expects a string");
    }

    const auto decoded = vayu::utils::base64_decode (js_to_string (ctx, argv[0]));
    if (!decoded) {
        return JS_ThrowTypeError (ctx, "atob: the string is not valid base64");
    }

    const std::string text = latin1_to_utf8 (*decoded);
    return JS_NewStringLen (ctx, text.data (), text.size ());
}

// Reads a hash input: a string contributes its UTF-8 bytes, a Uint8Array its
// bytes as they are. Anything else throws rather than being stringified -
// hashing the text "[object Object]" would be a silent wrong answer, and the
// digest gives the author no clue that it happened.
// Deliberately built from JS_GetTypedArrayBuffer + JS_GetArrayBuffer rather
// than JS_GetUint8Array: the engine vendors Bellard's QuickJS on Linux and
// macOS and quickjs-ng on Windows, and only the latter has the Uint8Array
// shortcuts. These two calls exist in both.
bool read_crypto_bytes (JSContext* ctx, JSValueConst value, const char* what, std::string& out) {
    if (JS_IsString (value)) {
        out = js_to_string (ctx, value);
        return true;
    }

    size_t byte_offset  = 0;
    size_t byte_length  = 0;
    size_t element_size = 0;
    JSValue buffer =
    JS_GetTypedArrayBuffer (ctx, value, &byte_offset, &byte_length, &element_size);

    if (!JS_IsException (buffer)) {
        // A wider element type would make the digest depend on this machine's
        // byte order, so only byte-sized views are accepted.
        if (element_size != 1) {
            JS_FreeValue (ctx, buffer);
            JS_ThrowTypeError (ctx,
            "%s must be a byte-sized typed array (Uint8Array); a %zu-byte "
            "element type would hash in this machine's byte order",
            what, element_size);
            return false;
        }

        size_t buffer_size = 0;
        uint8_t* base      = JS_GetArrayBuffer (ctx, &buffer_size, buffer);
        JS_FreeValue (ctx, buffer);

        // A detached buffer reads as zero length with a null base; hashing
        // nothing and calling it a digest of the caller's data is the silent
        // wrong answer this whole path exists to avoid.
        if (!base || byte_offset + byte_length > buffer_size) {
            JS_FreeValue (ctx, JS_GetException (ctx));
            JS_ThrowTypeError (ctx, "%s is backed by a detached buffer", what);
            return false;
        }

        out.assign (reinterpret_cast<const char*> (base + byte_offset), byte_length);
        return true;
    }

    // JS_GetTypedArrayBuffer threw its own TypeError for the not-a-typed-array
    // case; replace it with one that names the argument and what is accepted.
    JS_FreeValue (ctx, JS_GetException (ctx));
    JS_ThrowTypeError (ctx, "%s must be a string or a Uint8Array", what);
    return false;
}

// Turns a digest into whatever the caller asked for. 'bytes' exists so a digest
// can be fed back in as a key: multi-round key derivation (AWS SigV4 signs with
// the raw digest of the previous round) is impossible when the only outputs are
// text.
JSValue encode_digest (JSContext* ctx,
const std::array<uint8_t, 32>& digest,
const std::string& encoding) {
    const std::string_view raw = vayu::utils::byte_view (digest);

    if (encoding == "bytes") {
        // Constructed through the global Uint8Array rather than a helper, for
        // the same cross-vendor reason as read_crypto_bytes.
        JSValue global = JS_GetGlobalObject (ctx);
        JSValue ctor   = JS_GetPropertyStr (ctx, global, "Uint8Array");
        JS_FreeValue (ctx, global);
        if (!JS_IsFunction (ctx, ctor)) {
            JS_FreeValue (ctx, ctor);
            return JS_ThrowTypeError (ctx, "Uint8Array is not available in this context");
        }

        JSValue buffer = JS_NewArrayBufferCopy (ctx, digest.data (), digest.size ());
        JSValue array = JS_CallConstructor (ctx, ctor, 1, &buffer);
        JS_FreeValue (ctx, buffer);
        JS_FreeValue (ctx, ctor);
        return array;
    }

    std::string out;
    if (encoding == "hex") {
        out = vayu::utils::hex_encode (raw);
    } else if (encoding == "base64") {
        out = vayu::utils::base64_encode (raw);
    } else if (encoding == "base64url") {
        out = vayu::utils::base64url_encode (raw);
    } else {
        return JS_ThrowTypeError (ctx,
        "unknown digest encoding '%s' - expected 'hex', 'base64', "
        "'base64url' or 'bytes'",
        encoding.c_str ());
    }

    return JS_NewStringLen (ctx, out.data (), out.size ());
}

// The encoding argument, which is optional and defaults to hex. An explicit
// undefined is the same as omitting it; anything else non-string is a typo
// worth failing on rather than coercing to a name that then fails anyway.
bool read_digest_encoding (JSContext* ctx, int argc, JSValueConst* argv, int index, std::string& out) {
    out = "hex";
    if (argc <= index || JS_IsUndefined (argv[index])) {
        return true;
    }
    if (!JS_IsString (argv[index])) {
        JS_ThrowTypeError (ctx, "the encoding must be a string");
        return false;
    }
    out = js_to_string (ctx, argv[index]);
    return true;
}

JSValue js_crypto_sha256 (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "pm.crypto.sha256 requires data");
    }

    std::string data;
    if (!read_crypto_bytes (ctx, argv[0], "pm.crypto.sha256 data", data)) {
        return JS_EXCEPTION;
    }

    std::string encoding;
    if (!read_digest_encoding (ctx, argc, argv, 1, encoding)) {
        return JS_EXCEPTION;
    }

    return encode_digest (ctx, vayu::utils::sha256 (data), encoding);
}

JSValue js_crypto_hmac_sha256 (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 2) {
        return JS_ThrowTypeError (ctx, "pm.crypto.hmacSha256 requires a key and data");
    }

    std::string key;
    if (!read_crypto_bytes (ctx, argv[0], "pm.crypto.hmacSha256 key", key)) {
        return JS_EXCEPTION;
    }

    std::string data;
    if (!read_crypto_bytes (ctx, argv[1], "pm.crypto.hmacSha256 data", data)) {
        return JS_EXCEPTION;
    }

    std::string encoding;
    if (!read_digest_encoding (ctx, argc, argv, 2, encoding)) {
        return JS_EXCEPTION;
    }

    return encode_digest (ctx, vayu::utils::hmac_sha256 (key, data), encoding);
}

void setup_base64_globals (JSContext* ctx) {
    JSValue global = JS_GetGlobalObject (ctx);
    JS_SetPropertyStr (ctx, global, "btoa", JS_NewCFunction (ctx, js_btoa, "btoa", 1));
    JS_SetPropertyStr (ctx, global, "atob", JS_NewCFunction (ctx, js_atob, "atob", 1));
    JS_FreeValue (ctx, global);
}

void setup_pm_crypto (JSContext* ctx, JSValue pm) {
    JSValue crypto = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, crypto, "sha256", JS_NewCFunction (ctx, js_crypto_sha256, "sha256", 2));
    JS_SetPropertyStr (ctx, crypto, "hmacSha256",
    JS_NewCFunction (ctx, js_crypto_hmac_sha256, "hmacSha256", 3));
    JS_SetPropertyStr (ctx, pm, "crypto", crypto);
}

// ============================================================================
// pm Object Implementation
// ============================================================================

JSValue js_pm_test (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 2) {
        return JS_ThrowTypeError (ctx, "pm.test requires name and callback");
    }

    auto* data            = get_context_data (ctx);
    std::string test_name = js_to_string (ctx, argv[0]);

    TestResult result;
    result.name = test_name;

    // Call the test function
    JSValue ret = JS_Call (ctx, argv[1], JS_UNDEFINED, 0, nullptr);

    if (JS_IsException (ret)) {
        JSValue exc          = JS_GetException (ctx);
        result.passed        = false;
        result.error_message = js_to_string (ctx, exc);
        JS_FreeValue (ctx, exc);
    } else {
        result.passed = true;
    }

    JS_FreeValue (ctx, ret);
    data->tests.push_back (std::move (result));

    return JS_UNDEFINED;
}

JSValue js_pm_expect (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "pm.expect requires a value");
    }

    // chai coerces the message rather than demanding a string, and treats an
    // absent one and an explicit `undefined` / `null` alike - both are how a
    // caller that computes the message conditionally spells "no message". A
    // value whose conversion throws (a Symbol, a throwing `toString`) is a real
    // error and propagates rather than being swallowed into an empty prefix.
    std::string message;
    if (argc >= 2 && !JS_IsUndefined (argv[1]) && !JS_IsNull (argv[1])) {
        const char* str = JS_ToCString (ctx, argv[1]);
        if (!str) {
            return JS_EXCEPTION;
        }
        message = str;
        JS_FreeCString (ctx, str);
    }

    return create_expectation (ctx, argv[0], std::move (message));
}

// json() and text() read the body bound to the function at build time rather
// than the response hanging off the context, so `pm.response` and the response
// a pm.sendRequest callback receives are served by one implementation instead
// of two that can drift. Both are installed by `install_response_body_readers`.
JSValue js_response_json (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;

    size_t length    = 0;
    const char* body = JS_ToCStringLen (ctx, &length, func_data[0]);
    if (!body) {
        return JS_EXCEPTION;
    }
    JSValue json = JS_ParseJSON (ctx, body, length, "<response>");
    JS_FreeCString (ctx, body);
    if (JS_IsException (json)) {
        // Replaces QuickJS's parse error, which names an offset into a string
        // the script never sees.
        JS_FreeValue (ctx, JS_GetException (ctx));
        return JS_ThrowTypeError (ctx, "Response body is not valid JSON");
    }

    return json;
}

JSValue js_response_text (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;

    return JS_DupValue (ctx, func_data[0]);
}

// Install json()/text() on @p response, bound to @p body.
void install_response_body_readers (JSContext* ctx, JSValue response, const std::string& body) {
    JSValue bound = JS_NewStringLen (ctx, body.data (), body.size ());

    JS_SetPropertyStr (ctx, response, "json",
    JS_NewCFunctionData (ctx, js_response_json, 0, 0, 1, &bound));
    JS_SetPropertyStr (ctx, response, "text",
    JS_NewCFunctionData (ctx, js_response_text, 0, 0, 1, &bound));

    JS_FreeValue (ctx, bound);
}

// ============================================================================
// pm.response.to.have Assertions (Postman-compatible)
// ============================================================================

// These are chai assertions in Postman exactly as `pm.expect` is, so their
// failures throw through `throw_assertion_failure` too - a report that named
// one form `AssertionError` and the other `TypeError` would be a distinction
// with nothing behind it. They carry no chai message argument (`status(200)`
// takes a status code, not a message), so they call the helper directly rather
// than through `throw_expect_failure`, which exists to apply that prefix.

// The reason phrase as `pm.response.reason()` answers it: what the status line
// carried when it carried one, and the registered phrase for the code when it
// did not - HTTP/2 has no reason phrase on the wire at all. One definition,
// because `to.have.status("OK")` and `reason()` are two readings of the same
// response and a script that compares them must not get two answers.
std::string response_reason_phrase (const Response& response) {
    if (!response.status_text.empty ()) {
        return response.status_text;
    }
    return vayu::http::status_text (response.status_code);
}

// A body can be megabytes, so a failure message quotes a bounded prefix rather
// than the whole of it - and cuts on a UTF-8 boundary, because a message split
// mid-sequence reaches the report as replacement characters.
constexpr std::string::size_type kBodyExcerptBytes = 120;

std::string describe_body (const std::string& body) {
    if (body.size () <= kBodyExcerptBytes) {
        return "'" + body + "'";
    }
    std::string::size_type cut = kBodyExcerptBytes;
    while (cut > 0 && (static_cast<unsigned char> (body[cut]) & 0xC0) == 0x80) {
        --cut;
    }
    return "'" + body.substr (0, cut) + "...' (" + std::to_string (body.size ()) + " bytes)";
}

JSValue js_response_have_status (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "status() requires an expected status code");
    }

    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    // Postman takes either form and decides by type, never by coercion:
    // chai-postman compares a string against `reason()` and a number against
    // the code. Coercing both through `JS_ToInt32` read "OK" as 0 - failing an
    // assertion Postman passes - and "200" as 200 - passing one Postman fails.
    if (JS_IsString (argv[0])) {
        const std::string expected_reason = js_to_string (ctx, argv[0]);
        const std::string actual_reason = response_reason_phrase (*data->response);
        if (actual_reason != expected_reason) {
            std::string msg = "Expected status reason '" + expected_reason +
            "' but got '" + actual_reason + "'";
            return throw_assertion_failure (ctx, msg);
        }
        return JS_UNDEFINED;
    }

    int32_t expected_status;
    if (JS_ToInt32 (ctx, &expected_status, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "status() expects a number");
    }

    if (data->response->status_code != expected_status) {
        std::string msg = "Expected status code " + std::to_string (expected_status) +
        " but got " + std::to_string (data->response->status_code);
        return throw_assertion_failure (ctx, msg);
    }

    return JS_UNDEFINED;
}

JSValue js_response_have_header (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "header() requires a header name");
    }

    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    std::string header_name = js_to_string (ctx, argv[0]);

    // Case-insensitive header lookup
    bool found = false;
    std::string found_value;
    for (const auto& [key, value] : data->response->headers) {
        std::string lower_key  = key;
        std::string lower_name = header_name;
        std::transform (lower_key.begin (), lower_key.end (), lower_key.begin (), ::tolower);
        std::transform (
        lower_name.begin (), lower_name.end (), lower_name.begin (), ::tolower);
        if (lower_key == lower_name) {
            found       = true;
            found_value = value;
            break;
        }
    }

    if (!found) {
        std::string msg = "Expected response to have header '" + header_name + "'";
        return throw_assertion_failure (ctx, msg);
    }

    // A header value is a string on the wire, and chai-postman compares the
    // expected value against it strictly. Coercing the expectation instead let
    // `header("X-Count", 5)` pass against the string "5" - a verdict Postman
    // does not give - so a non-string expectation fails the assertion here
    // rather than being stringified into agreement with the wire.
    if (argc >= 2) {
        const bool matches =
        JS_IsString (argv[1]) && js_to_string (ctx, argv[1]) == found_value;
        if (!matches) {
            std::string msg = "Expected header '" + header_name + "' to be " +
            js_describe (ctx, argv[1]) + " but got '" + found_value + "'";
            return throw_assertion_failure (ctx, msg);
        }
    }

    return JS_UNDEFINED;
}

JSValue js_response_have_body (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "body() requires expected content");
    }

    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    const std::string& body = data->response->body;

    // chai-postman decides by the argument's type, and each form is a
    // different comparison: a string is exact, a regular expression is
    // executed against the body, an object is deep-equalled against the parsed
    // JSON. Vayu stringified all three and substring-searched the result, so a
    // partial string passed where Postman fails, and a regex or an object was
    // searched for as the literal text "/re/" or "[object Object]" - failing
    // where Postman passes.
    if (JS_IsString (argv[0])) {
        const std::string expected = js_to_string (ctx, argv[0]);
        if (body != expected) {
            std::string msg = "Expected response body to be '" + expected +
            "' but got " + describe_body (body);
            return throw_assertion_failure (ctx, msg);
        }
        return JS_UNDEFINED;
    }

    if (!JS_IsObject (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "body() expects a string, a regular expression or an object, got %s",
        js_type_name (ctx, argv[0]));
    }

    // A pattern is whatever carries a callable `test`, which is how
    // `expect(...).to.match` reads one: a regular expression literal is a real
    // RegExp here and satisfies it, and a matcher object a script built itself
    // is run rather than silently deep-equalled against the body.
    JSValue test_fn = JS_GetPropertyStr (ctx, argv[0], "test");
    // Reading `test` runs a getter if the script defined one, and a getter that
    // throws leaves the exception pending. Falling through to the deep-equal
    // branch there would report a mismatch and drop the script's own error -
    // the shape of silent wrongness this assertion was fixed for.
    if (JS_IsException (test_fn)) {
        return JS_EXCEPTION;
    }
    if (JS_IsFunction (ctx, test_fn)) {
        JSValue subject = JS_NewString (ctx, body.c_str ());
        JSValue result  = JS_Call (ctx, test_fn, argv[0], 1, &subject);
        JS_FreeValue (ctx, subject);
        JS_FreeValue (ctx, test_fn);
        if (JS_IsException (result)) {
            JS_FreeValue (ctx, result);
            return JS_EXCEPTION;
        }
        const bool matched = JS_ToBool (ctx, result) == 1;
        JS_FreeValue (ctx, result);
        if (!matched) {
            std::string msg =
            "Expected response body to match the pattern but got " + describe_body (body);
            return throw_assertion_failure (ctx, msg);
        }
        return JS_UNDEFINED;
    }
    JS_FreeValue (ctx, test_fn);

    JSValue json = JS_ParseJSON (ctx, body.c_str (), body.size (), "<response>");
    if (JS_IsException (json)) {
        // Swallow the parse exception so we report a clean assertion failure.
        JS_FreeValue (ctx, JS_GetException (ctx));
        return throw_assertion_failure (ctx, "Response body is not valid JSON");
    }

    DeepEqualPath path;
    const int same = js_deep_equal (ctx, json, argv[0], 0, path);
    JS_FreeValue (ctx, json);
    if (same < 0) {
        return JS_EXCEPTION;
    }
    if (same == 0) {
        std::string msg = "Expected response body to deeply equal " +
        js_describe (ctx, argv[0]) + " but got " + describe_body (body);
        return throw_assertion_failure (ctx, msg);
    }

    return JS_UNDEFINED;
}

JSValue js_response_have_jsonBody (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    // Parse body as JSON
    JSValue json = JS_ParseJSON (ctx, data->response->body.c_str (),
    data->response->body.size (), "<response>");
    if (JS_IsException (json)) {
        // Swallow the parse exception so we report a clean assertion failure.
        JS_FreeValue (ctx, JS_GetException (ctx));
        return throw_assertion_failure (ctx, "Response body is not valid JSON");
    }

    // No-arg form asserts only that the body is valid JSON (Postman semantics).
    if (argc < 1) {
        JS_FreeValue (ctx, json);
        return JS_UNDEFINED;
    }

    std::string prop_path = js_to_string (ctx, argv[0]);

    // Navigate to the property
    JSValue current              = JS_DupValue (ctx, json);
    std::string::size_type start = 0;
    std::string::size_type end;

    while ((end = prop_path.find ('.', start)) != std::string::npos ||
    start < prop_path.size ()) {
        std::string key = (end != std::string::npos) ?
        prop_path.substr (start, end - start) :
        prop_path.substr (start);

        if (key.empty ())
            break;

        JSValue next = JS_GetPropertyStr (ctx, current, key.c_str ());
        JS_FreeValue (ctx, current);
        current = next;

        if (JS_IsUndefined (current)) {
            JS_FreeValue (ctx, json);
            std::string msg = "Expected response body to have property '" + prop_path + "'";
            return throw_assertion_failure (ctx, msg);
        }

        if (end == std::string::npos)
            break;
        start = end + 1;
    }

    // chai-postman's two-argument form is `_.has(json, path)` and then
    // `_.isEqual(_.get(json, path), value)`. Vayu walked the path and stopped,
    // never reading the expected value at all, so every value-checking
    // assertion in an imported suite passed on any value the path held - the
    // silent false pass #998 was filed for.
    if (argc >= 2) {
        DeepEqualPath path;
        const int same = js_deep_equal (ctx, current, argv[1], 0, path);
        if (same < 0) {
            JS_FreeValue (ctx, current);
            JS_FreeValue (ctx, json);
            return JS_EXCEPTION;
        }
        if (same == 0) {
            std::string msg = "Expected response body property '" + prop_path +
            "' to deeply equal " + js_describe (ctx, argv[1]) + " but got " +
            js_describe (ctx, current);
            JS_FreeValue (ctx, current);
            JS_FreeValue (ctx, json);
            return throw_assertion_failure (ctx, msg);
        }
    }

    JS_FreeValue (ctx, current);
    JS_FreeValue (ctx, json);
    return JS_UNDEFINED;
}

// ============================================================================
// pm.response.to.be Status-Class Assertions
// ============================================================================

// Each matcher asserts the status code falls in [lo, hi]. Single-code matchers
// set lo == hi. `expectation` completes "Expected response to have ...".
struct StatusClassMatcher {
    const char* name;
    int lo;
    int hi;
    const char* expectation;
};

// Status ranges only. The body-shape assertions (`json`, `withBody`) are not
// ranges, so they get their own getters below.
constexpr StatusClassMatcher status_class_matchers[] = {
    { "info", 100, 199, "a 1xx status code" },
    // `ok` is a named code in chai-postman, not a class: it asserts 200, so a
    // 204 passes here and fails in Postman while the two ranges agree. Vayu
    // scripts that meant the class have `success`, which is the 2xx one in
    // both - the migration note is in docs/app/pm-api-compatibility.md.
    { "ok", 200, 200, "status 200" },
    { "success", 200, 299, "a 2xx status code" },
    { "accepted", 202, 202, "status 202" },
    { "redirection", 300, 399, "a 3xx status code" },
    { "clientError", 400, 499, "a 4xx status code" },
    { "badRequest", 400, 400, "status 400" },
    { "unauthorized", 401, 401, "status 401" },
    { "forbidden", 403, 403, "status 403" },
    { "notFound", 404, 404, "status 404" },
    { "rateLimited", 429, 429, "status 429" },
    { "serverError", 500, 599, "a 5xx status code" },
    { "error", 400, 599, "a 4xx or 5xx status code" },
};

// `magic` indexes status_class_matchers. Registered as a getter, never a plain
// property: `pm.response.to.be.ok` is written without parentheses, so a
// function-valued property would be a discarded reference that asserts nothing
// (the defect ExpectTrueFalseAssertsOnAccess pins for pm.expect).
JSValue js_response_be_status_class (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    const StatusClassMatcher& matcher = status_class_matchers[magic];
    const int code                    = data->response->status_code;
    if (code < matcher.lo || code > matcher.hi) {
        std::string msg = std::string ("Expected response to have ") +
        matcher.expectation + " but got " + std::to_string (code);
        return throw_assertion_failure (ctx, msg);
    }

    return JS_UNDEFINED;
}

JSValue js_response_be_json (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    JSValue json = JS_ParseJSON (ctx, data->response->body.c_str (),
    data->response->body.size (), "<response>");
    if (JS_IsException (json)) {
        return throw_assertion_failure (ctx, "Expected response body to be valid JSON");
    }
    JS_FreeValue (ctx, json);

    return JS_UNDEFINED;
}

JSValue js_response_be_with_body (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    if (data->response->body.empty ()) {
        return throw_assertion_failure (ctx, "Expected response to have a body");
    }

    return JS_UNDEFINED;
}

// ============================================================================
// pm.response.to chain objects
// ============================================================================

// Every link in the chain carries this class. Its exotic hook turns an
// unrecognised member into a throw: `pm.response.to.be.ok` is an expression
// statement, so a member that does not exist evaluates to undefined and
// asserts nothing - a green test against a broken API, which is strictly worse
// than a missing matcher that fails loudly. Own properties are resolved before
// the hook runs, so it only ever sees names nothing implements.
JSClassID response_chain_class_id = 0;

// Names the engine itself probes on an arbitrary value. Answering "no own
// property" for them keeps JSON.stringify and promise resolution working;
// reporting them as misspelled assertions would make console.log(pm.response)
// throw. They are not on Object.prototype, so the prototype check below does
// not cover them.
constexpr const char* response_chain_passthrough[] = { "toJSON", "then" };

int response_chain_unknown_member (JSContext* ctx,
JSPropertyDescriptor* desc,
JSValueConst obj,
JSAtom prop) {
    (void)desc;

    // The opaque path doubles as the armed flag. Defining a property looks up
    // the existing own property first, so a hook that threw from the moment the
    // object existed would reject the chain's own members as they are installed
    // - arm_response_chain_object runs last, once every member is in place.
    const auto* path =
    static_cast<const char*> (JS_GetOpaque (obj, response_chain_class_id));
    if (!path) {
        return 0;
    }

    // Symbol keys (Symbol.toPrimitive, Symbol.toStringTag) are plumbing too.
    JSValue key              = JS_AtomToValue (ctx, prop);
    const bool is_string_key = JS_IsString (key);
    JS_FreeValue (ctx, key);
    if (!is_string_key) {
        return 0;
    }

    const char* name_cstr = JS_AtomToCString (ctx, prop);
    const std::string name (name_cstr ? name_cstr : "<unknown>");
    JS_FreeCString (ctx, name_cstr);

    for (const char* passthrough : response_chain_passthrough) {
        if (name == passthrough) {
            return 0;
        }
    }

    // Anything the prototype answers (toString, hasOwnProperty) is not an
    // assertion either; let the normal lookup continue to it.
    JSValue proto = JS_GetPrototype (ctx, obj);
    const int on_proto = JS_IsObject (proto) ? JS_HasProperty (ctx, proto, prop) : 0;
    JS_FreeValue (ctx, proto);
    if (on_proto != 0) {
        return on_proto < 0 ? -1 : 0;
    }

    const std::string msg = std::string (path) + "." + name + " is not a supported assertion";
    JS_ThrowTypeError (ctx, "%s", msg.c_str ());
    return -1;
}

// Value-initialized and then assigned rather than written as a designated
// initializer: this is a QuickJS C struct, so it cannot carry default member
// initializers, and naming one of its seven hooks leaves the other six as
// -Wmissing-field-initializers warnings.
JSClassExoticMethods response_chain_exotic = [] {
    JSClassExoticMethods exotic{};
    exotic.get_own_property = response_chain_unknown_member;
    return exotic;
}();

JSClassDef response_chain_class = { .class_name = "ResponseAssertionChain",
    .finalizer                                  = nullptr,
    .gc_mark                                    = nullptr,
    .call                                       = nullptr,
    .exotic                                     = &response_chain_exotic };

JSValue create_response_chain_object (JSContext* ctx) {
    return JS_NewObjectClass (ctx, response_chain_class_id);
}

// Arms the unknown-member hook. Call once the object holds every member it is
// meant to have; `path` names the chain in the error and must outlive the
// object, so every caller passes a string literal and the class needs no
// finalizer.
void arm_response_chain_object (JSValue obj, const char* path) {
    (void)JS_SetOpaque (obj, const_cast<char*> (path));
}

// Create the pm.response.to.have chain object
JSValue create_response_have_object (JSContext* ctx) {
    JSValue have = create_response_chain_object (ctx);
    if (JS_IsException (have)) {
        return have;
    }
    JS_SetPropertyStr (ctx, have, "status",
    JS_NewCFunction (ctx, js_response_have_status, "status", 1));
    JS_SetPropertyStr (ctx, have, "header",
    JS_NewCFunction (ctx, js_response_have_header, "header", 2));
    JS_SetPropertyStr (
    ctx, have, "body", JS_NewCFunction (ctx, js_response_have_body, "body", 1));
    JS_SetPropertyStr (ctx, have, "jsonBody",
    JS_NewCFunction (ctx, js_response_have_jsonBody, "jsonBody", 1));
    arm_response_chain_object (have, "pm.response.to.have");
    return have;
}

// Create the pm.response.to.be chain object
JSValue create_response_be_object (JSContext* ctx) {
    JSValue be = create_response_chain_object (ctx);
    if (JS_IsException (be)) {
        return be;
    }

    int magic = 0;
    for (const auto& matcher : status_class_matchers) {
        JSAtom atom = JS_NewAtom (ctx, matcher.name);
        JS_DefinePropertyGetSet (ctx, be, atom,
        JS_NewCFunctionMagic (ctx, js_response_be_status_class, matcher.name, 0,
        JS_CFUNC_generic_magic, magic),
        JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
        magic++;
    }

    JSAtom json_atom = JS_NewAtom (ctx, "json");
    JS_DefinePropertyGetSet (ctx, be, json_atom,
    JS_NewCFunction (ctx, js_response_be_json, "json", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, json_atom);

    JSAtom with_body_atom = JS_NewAtom (ctx, "withBody");
    JS_DefinePropertyGetSet (ctx, be, with_body_atom,
    JS_NewCFunction (ctx, js_response_be_with_body, "withBody", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, with_body_atom);

    arm_response_chain_object (be, "pm.response.to.be");
    return be;
}

// Create the pm.response.to chain object
JSValue create_response_to_object (JSContext* ctx) {
    JSValue to = create_response_chain_object (ctx);
    if (JS_IsException (to)) {
        return to;
    }
    JS_SetPropertyStr (ctx, to, "have", create_response_have_object (ctx));
    JS_SetPropertyStr (ctx, to, "be", create_response_be_object (ctx));
    arm_response_chain_object (to, "pm.response.to");
    return to;
}

// ============================================================================
// Header accessors (pm.request.headers / pm.response.headers)
// ============================================================================

// Name a rejected value the way the script author wrote it, so the error says
// "got number" rather than showing them a coerced "[object Object]". Shared by
// the header methods below and by the pm.request write-back further down.
const char* js_type_name (JSContext* ctx, JSValueConst value) {
    if (JS_IsUndefined (value))
        return "undefined";
    if (JS_IsNull (value))
        return "null";
    if (JS_IsBool (value))
        return "boolean";
    if (JS_IsNumber (value))
        return "number";
    if (JS_IsString (value))
        return "string";
    if (JS_IsFunction (ctx, value))
        return "function";
    if (JS_IsArray (value))
        return "array";
    if (JS_IsObject (value))
        return "object";
    return "value";
}

// The methods live on the very object that holds the header entries, because
// `apply_pm_request_writeback` reads *that* object - so a header added by
// `add()` and one added by assignment have to be the same property or the two
// views disagree about what is sent.
//
// They must therefore be invisible to the write-back, which enumerates own
// **enumerable** string properties: an enumerable `get` would be read as a
// header whose value is a function and would fail the whole write-back. Hence
// the two flag sets below - methods without JS_PROP_ENUMERABLE, entries with
// JS_PROP_C_W_E. Entries are *defined* rather than set so a header literally
// named `get` overwrites the method attributes as well as its value and still
// reaches the wire; a silently dropped header is the defect this whole surface
// exists to avoid, and a shadowed method throws loudly instead.
constexpr int HEADER_METHOD_FLAGS = JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE;

void define_header_entry (JSContext* ctx,
JSValue headers,
const std::string& name,
const std::string& value) {
    JS_DefinePropertyValueStr (ctx, headers, name.c_str (),
    JS_NewString (ctx, value.c_str ()), JS_PROP_C_W_E);
}

/// A header name as a case-insensitive index keys it - which is the spelling
/// Postman's `toObject()` hands back, and the only place here that needs one.
/// The engine has no primitive for the fold and hand-rolls it 29 times; that is
/// filed as #1060 rather than converted from under this one caller.
std::string header_name_lowered (const std::string& name) {
    std::string lowered = name;
    std::transform (lowered.begin (), lowered.end (), lowered.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
    return lowered;
}

bool header_names_equal (const std::string& a, const std::string& b) {
    return a.size () == b.size () &&
    std::equal (a.begin (), a.end (), b.begin (), [] (unsigned char c1, unsigned char c2) {
        return std::tolower (c1) == std::tolower (c2);
    });
}

// The own enumerable key naming `name`, spelled the way the object spells it.
// HTTP header names are case-insensitive and JS object keys are not, so an
// exact lookup would miss `Content-Type` on a response (whose keys the HTTP
// client has lower-cased) and `content-type` on a request (whose keys keep
// whatever the user typed).
/// The header names the object holds, in the order it holds them - which is the
/// order the source `Headers` map was walked in when the entries were defined,
/// and so the order every read below reports. The methods are non-enumerable
/// (HEADER_METHOD_FLAGS), so they are never among the names. `std::nullopt`
/// means QuickJS left an exception pending.
std::optional<std::vector<std::string>> header_key_order (JSContext* ctx, JSValueConst headers) {
    std::vector<std::string> keys;
    if (!js_own_enumerable_keys (ctx, headers, keys)) {
        return std::nullopt;
    }
    return keys;
}

std::optional<std::string>
find_header_key (JSContext* ctx, JSValueConst headers, const std::string& name) {
    auto keys = header_key_order (ctx, headers);
    if (!keys) {
        return std::nullopt;
    }
    for (auto& key : *keys) {
        if (header_names_equal (key, name)) {
            return std::move (key);
        }
    }
    return std::nullopt;
}

// `this` is the header object the method was reached through. Detaching a
// method from it (`const get = pm.response.headers.get; get('x')`) leaves
// `this` undefined, which would otherwise read as "no such header" - a wrong
// answer dressed as a real one.
bool header_this_is_usable (JSContext* ctx, JSValueConst this_val, const char* member) {
    if (JS_IsObject (this_val) && !JS_IsFunction (ctx, this_val)) {
        return true;
    }
    JS_ThrowTypeError (ctx,
    "headers.%s must be called on a headers object (got %s) - call it as "
    "pm.request.headers.%s(...) rather than detaching it",
    member, js_type_name (ctx, this_val), member);
    return false;
}

// A header name is a non-empty string or nothing. Coercing a number here would
// invent a field name; the write-back refuses non-primitive values for the same
// reason.
std::optional<std::string>
read_header_name_arg (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString (argv[0])) {
        JS_ThrowTypeError (ctx, "headers.%s(name) needs a header name string, got %s",
        member, argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
        return std::nullopt;
    }
    std::string name = js_to_string (ctx, argv[0]);
    if (name.empty ()) {
        JS_ThrowTypeError (ctx, "headers.%s(name) needs a non-empty header name", member);
        return std::nullopt;
    }
    return name;
}

// The same primitive set the write-back accepts, so a value that survives a
// method call is a value that survives being sent.
std::optional<std::string> read_header_value_arg (JSContext* ctx,
const char* member,
const std::string& name,
JSValueConst value) {
    if (JS_IsString (value) || JS_IsNumber (value) || JS_IsBool (value)) {
        return js_to_string (ctx, value);
    }
    JS_ThrowTypeError (ctx, "headers.%s: value for '%s' must be a string, number or boolean, got %s",
    member, name.c_str (), js_type_name (ctx, value));
    return std::nullopt;
}

JSValue js_headers_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "get")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "get", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto key = find_header_key (ctx, this_val, *name);
    if (!key) {
        // Postman returns undefined for an absent header; a throw here would
        // make the common `if (headers.get(x))` guard unwritable.
        return JS_UNDEFINED;
    }
    return JS_GetPropertyStr (ctx, this_val, key->c_str ());
}

// Postman's PropertyList spells this `has(key, value?)` and checks the value
// when one is given. Vayu read only the name, so `has(name, value)` answered
// true for any value the header held - a check that looked like one and was
// not. The comparison is strict against the wire string, as `to.have.header`'s
// is: a non-string expectation matches nothing rather than being coerced.
JSValue js_headers_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "has")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "has", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto key = find_header_key (ctx, this_val, *name);
    if (!key) {
        return JS_NewBool (ctx, 0);
    }
    if (argc < 2) {
        return JS_NewBool (ctx, 1);
    }
    if (!JS_IsString (argv[1])) {
        return JS_NewBool (ctx, 0);
    }
    JSValue stored           = JS_GetPropertyStr (ctx, this_val, key->c_str ());
    const std::string actual = js_to_string (ctx, stored);
    JS_FreeValue (ctx, stored);
    return JS_NewBool (ctx, actual == js_to_string (ctx, argv[1]) ? 1 : 0);
}

// Postman's header object is a PropertyList, and the six reads below are the
// half of it that only looks. `each` in particular is an everyday idiom - it
// threw here, which is how an imported script died on a line that reads nothing
// - so all six install on the response and sendRequest objects too, ahead of
// the `mutators` gate.
//
// What they cannot report is what this object no longer holds: `Headers` is a
// single-valued case-insensitive map, so a name the server sent twice arrived
// folded with ", " and the wire order is gone with it. The order below is the
// map's; the fold is documented beside these methods in both script docs.

/// One `{ key, value }` member - the shape Postman's PropertyList hands its
/// iterator, and the shape `add`/`upsert` already read back.
JSValue header_member (JSContext* ctx, JSValueConst headers, const std::string& key) {
    JSValue member = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, member, "key", JS_NewStringLen (ctx, key.data (), key.size ()));
    JS_SetPropertyStr (
    ctx, member, "value", JS_GetPropertyStr (ctx, headers, key.c_str ()));
    return member;
}

/// Every member as an array. `all()` itself, and the list `each()` walks - built
/// once, so a callback that removes a header does not shorten the walk under it.
JSValue header_member_list (JSContext* ctx,
JSValueConst headers,
const std::vector<std::string>& keys) {
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& key : keys) {
        JS_SetPropertyUint32 (ctx, list, next++, header_member (ctx, headers, key));
    }
    return list;
}

/// A name, or the `{ key, value }` member `all()` and `one()` hand back - the
/// two spellings `indexOf` answers to.
std::optional<std::string>
read_header_member_arg (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc >= 1 && JS_IsObject (argv[0]) && !JS_IsFunction (ctx, argv[0]) &&
    !JS_IsArray (argv[0])) {
        JSValue js_key = JS_GetPropertyStr (ctx, argv[0], "key");
        JSValueConst only[1]{ js_key };
        auto name = read_header_name_arg (ctx, member, 1, only);
        JS_FreeValue (ctx, js_key);
        return name;
    }
    return read_header_name_arg (ctx, member, argc, argv);
}

/// `headers.all()` - every header as a `{ key, value }`, in key order.
JSValue js_headers_all (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    if (!header_this_is_usable (ctx, this_val, "all")) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    return header_member_list (ctx, this_val, *keys);
}

/// `headers.count()` - how many headers, which is `all().length` without
/// building the array.
JSValue js_headers_count (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    if (!header_this_is_usable (ctx, this_val, "count")) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    return JS_NewInt32 (ctx, static_cast<int32_t> (keys->size ()));
}

/**
 * `headers.each(fn, thisArg)` - the iteration idiom, with Postman's arguments.
 *
 * postman-collection's `each` is `_.forEach(members, iterator.bind(context))`,
 * so the callback is handed `(member, index, list)` and the optional second
 * argument becomes its `this`. Passing only the member would have been the
 * smaller change and would silently hand `undefined` to a script that reads the
 * index - the class of quiet wrong answer this surface exists to close.
 */
JSValue js_headers_each (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "each")) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "headers.each(fn) needs a function, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }

    JSValue list                = header_member_list (ctx, this_val, *keys);
    const JSValueConst this_arg = argc >= 2 ? argv[1] : JS_UNDEFINED;
    JSValue outcome             = JS_UNDEFINED;
    for (uint32_t i = 0; i < keys->size (); i++) {
        JSValue member = JS_GetPropertyUint32 (ctx, list, i);
        JSValue index  = JS_NewInt32 (ctx, static_cast<int32_t> (i));
        JSValueConst args[3]{ member, index, list };
        JSValue returned = JS_Call (ctx, argv[0], this_arg, 3, args);
        JS_FreeValue (ctx, member);
        JS_FreeValue (ctx, index);
        if (JS_IsException (returned)) {
            // A throw out of the callback is the script's, not ours - it goes
            // back up as it is rather than being reported as an `each` failure.
            outcome = JS_EXCEPTION;
            break;
        }
        JS_FreeValue (ctx, returned);
    }
    JS_FreeValue (ctx, list);
    return outcome;
}

/**
 * `headers.toObject(excludeDisabled, caseSensitive)` - Postman's signature.
 *
 * Its header list is indexed case-insensitively, so `toObject()` there
 * **lower-cases every key**, and only `caseSensitive` keeps the spelling the
 * header was stored with. Copying the object's own keys instead - which is what
 * a plain enumeration would do - reads as the harmless choice and is not:
 * `pm.request.headers` keeps whatever the user typed, so
 * `toObject()['content-type']` would answer `undefined` here against a request
 * carrying `Content-Type`, and answer correctly in Postman.
 *
 * The other two switches Postman takes decide nothing here: `multiValue` has no
 * duplicate to unfold (they arrived folded), and `sanitizeKeys` no falsy key to
 * drop, since a header name is a non-empty string on both surfaces.
 */
JSValue js_headers_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "toObject")) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    const bool case_sensitive = argc >= 2 && JS_ToBool (ctx, argv[1]) == 1;

    JSValue out = JS_NewObject (ctx);
    for (const auto& key : *keys) {
        JSValue value = JS_GetPropertyStr (ctx, this_val, key.c_str ());
        const std::string prop = case_sensitive ? key : header_name_lowered (key);
        JS_SetPropertyStr (ctx, out, prop.c_str (), value);
    }
    return out;
}

/// `headers.one(name)` - the member rather than its value, `undefined` when the
/// header is absent. `get` is the value half of the same lookup.
JSValue js_headers_one (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "one")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "one", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto key = find_header_key (ctx, this_val, *name);
    if (!key) {
        return JS_UNDEFINED;
    }
    return header_member (ctx, this_val, *key);
}

/**
 * `headers.indexOf(name)` - the header's position in `all()`, `-1` when absent.
 *
 * Postman takes a member object here as well as a name, and finds it by
 * identity in its own member list. The members handed out here are built per
 * call, so identity would answer `-1` for a member of this very list; matching
 * the object's `key` answers what Postman answers for that case, and `-1` for
 * an object naming a header this list does not hold, as Postman's does.
 */
JSValue js_headers_index_of (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "indexOf")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_member_arg (ctx, "indexOf", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    for (uint32_t i = 0; i < keys->size (); i++) {
        if (header_names_equal ((*keys)[i], *name)) {
            return JS_NewInt32 (ctx, static_cast<int32_t> (i));
        }
    }
    return JS_NewInt32 (ctx, -1);
}

// Postman spells this `add({ key, value })`; Bruno spells it `(name, value)`.
// Both are accepted because both are idioms a user pastes in, and getting it
// wrong in either direction would otherwise name a header "[object Object]".
struct HeaderPair {
    std::string name;
    std::string value;
};

std::optional<HeaderPair>
read_header_pair_args (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc >= 2) {
        auto name = read_header_name_arg (ctx, member, argc, argv);
        if (!name) {
            return std::nullopt;
        }
        auto value = read_header_value_arg (ctx, member, *name, argv[1]);
        if (!value) {
            return std::nullopt;
        }
        return HeaderPair{ *name, *value };
    }

    if (argc == 1 && JS_IsObject (argv[0]) && !JS_IsFunction (ctx, argv[0]) &&
    !JS_IsArray (argv[0])) {
        JSValue js_key   = JS_GetPropertyStr (ctx, argv[0], "key");
        JSValue js_value = JS_GetPropertyStr (ctx, argv[0], "value");
        JSValueConst pair[2]{ js_key, js_value };
        auto name = read_header_name_arg (ctx, member, 1, pair);
        std::optional<std::string> value;
        if (name) {
            value = read_header_value_arg (ctx, member, *name, js_value);
        }
        JS_FreeValue (ctx, js_key);
        JS_FreeValue (ctx, js_value);
        if (!name || !value) {
            return std::nullopt;
        }
        return HeaderPair{ *name, *value };
    }

    JS_ThrowTypeError (ctx, "headers.%s takes ({ key, value }) or (name, value)", member);
    return std::nullopt;
}

// magic: 0 = add (refuses an existing name), 1 = upsert (replaces it).
JSValue js_request_headers_add_or_upsert (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    const bool is_upsert = magic == 1;
    const char* member   = is_upsert ? "upsert" : "add";
    if (!header_this_is_usable (ctx, this_val, member)) {
        return JS_EXCEPTION;
    }
    auto pair = read_header_pair_args (ctx, member, argc, argv);
    if (!pair) {
        return JS_EXCEPTION;
    }

    auto existing = find_header_key (ctx, this_val, pair->name);
    if (existing && !is_upsert) {
        // Postman's HeaderList holds duplicates and `add` appends one. This
        // object cannot: it is a JS object read into a case-insensitive
        // `Headers` map, so a second `X-Foo` has nowhere to live. Silently
        // behaving as `upsert` would hide the difference; refusing names it.
        return JS_ThrowTypeError (ctx,
        "headers.add: '%s' is already set (as '%s') and a request cannot carry "
        "it twice - use headers.upsert() to replace it",
        pair->name.c_str (), existing->c_str ());
    }

    // Write through the spelling already present, so `upsert('content-type')`
    // on a request holding `Content-Type` replaces it instead of creating a
    // second casing the write-back would then refuse as a clash.
    define_header_entry (ctx, this_val, existing ? *existing : pair->name, pair->value);
    return JS_UNDEFINED;
}

JSValue js_request_headers_remove (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "remove")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "remove", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    // Removing a header that is not there is idempotent, not a mistake -
    // `remove('Authorization')` on a request that never had one is exactly what
    // a defensive script writes.
    if (auto key = find_header_key (ctx, this_val, *name)) {
        JSAtom atom = JS_NewAtom (ctx, key->c_str ());
        JS_DeleteProperty (ctx, this_val, atom, 0);
        JS_FreeAtom (ctx, atom);
    }
    return JS_UNDEFINED;
}

// `mutators` gates the three that only mean something before the request is
// sent. They are still installed on a test script's pm.request.headers, where
// they mutate an object nothing reads back - the same no-op that assignment
// already is there, documented in both script docs.
void install_header_methods (JSContext* ctx, JSValue headers, bool mutators) {
    // The reads are eight of one shape, so they are a table and a loop - the
    // idiom `build_query_object` uses for the same job further down. The three
    // mutators are not: two of them share one implementation through a magic
    // number, and spelling that in the table would cost more than it saves.
    struct HeaderRead {
        const char* name;
        JSCFunction* fn;
        int length;
    };
    static constexpr std::array<HeaderRead, 8> READS = {
        HeaderRead{ "get", js_headers_get, 1 },
        HeaderRead{ "has", js_headers_has, 1 },
        HeaderRead{ "each", js_headers_each, 1 },
        HeaderRead{ "all", js_headers_all, 0 },
        HeaderRead{ "count", js_headers_count, 0 },
        HeaderRead{ "toObject", js_headers_to_object, 0 },
        HeaderRead{ "one", js_headers_one, 1 },
        HeaderRead{ "indexOf", js_headers_index_of, 1 },
    };
    for (const auto& read : READS) {
        JS_DefinePropertyValueStr (ctx, headers, read.name,
        JS_NewCFunction (ctx, read.fn, read.name, read.length), HEADER_METHOD_FLAGS);
    }

    if (!mutators) {
        return;
    }
    JS_DefinePropertyValueStr (ctx, headers, "add",
    JS_NewCFunctionMagic (
    ctx, js_request_headers_add_or_upsert, "add", 2, JS_CFUNC_generic_magic, 0),
    HEADER_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, headers, "upsert",
    JS_NewCFunctionMagic (ctx, js_request_headers_add_or_upsert, "upsert", 2,
    JS_CFUNC_generic_magic, 1),
    HEADER_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, headers, "remove",
    JS_NewCFunction (ctx, js_request_headers_remove, "remove", 1), HEADER_METHOD_FLAGS);
}

// pm.response.reason() - the status line's reason phrase. Postman returns null
// when there is none; vayu always has one, because status 0 (its synthetic
// value for a client-side failure) is in the canonical table as "Error".
JSValue js_response_reason (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }
    return JS_NewString (ctx, response_reason_phrase (*data->response).c_str ());
}

// pm.response.size() -> { body, header, total }, in bytes.
//
// `body` is the body the script can actually read through text(), so
// size().body and text().length agree for an ASCII body. `header` is the
// serialised block - "Name: Value\r\n" each - reconstructed from the parsed
// headers rather than measured off the wire, so it will not match a
// Content-Length-derived figure to the byte.
JSValue js_response_size (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    constexpr size_t separator_and_crlf = 4; // ": " + "\r\n"
    size_t header_bytes                 = 0;
    for (const auto& [key, value] : data->response->headers) {
        header_bytes += key.size () + value.size () + separator_and_crlf;
    }
    const size_t body_bytes = data->response->body.size ();

    JSValue size = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, size, "body", JS_NewInt64 (ctx, static_cast<int64_t> (body_bytes)));
    JS_SetPropertyStr (
    ctx, size, "header", JS_NewInt64 (ctx, static_cast<int64_t> (header_bytes)));
    JS_SetPropertyStr (ctx, size, "total",
    JS_NewInt64 (ctx, static_cast<int64_t> (body_bytes + header_bytes)));
    return size;
}

// ============================================================================
// pm.response.cookies
// ============================================================================

// Methods hang off the list without being enumerable, so Object.keys() and a
// spread over it see cookies and nothing else.
constexpr int COOKIE_METHOD_FLAGS = JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE;

// Cookie names are case-sensitive (RFC 6265 §4.1.1) - unlike header names, so
// this is an exact match and not `header_names_equal`.
//
// The last definition wins: a response that sets the same name twice leaves the
// later value in a browser's jar, so that is the one a script asking "what is
// the session cookie now" has to be told.
const vayu::http::SetCookie*
find_cookie (const std::vector<vayu::http::SetCookie>& cookies, const std::string& name) {
    for (auto it = cookies.rbegin (); it != cookies.rend (); ++it) {
        if (it->name == name) {
            return &*it;
        }
    }
    return nullptr;
}

// The list methods read the response rather than the array they were reached
// through, so editing the array cannot make get() disagree with the wire. The
// re-parse is bounded by one header and only happens when a script calls one.
std::optional<std::vector<vayu::http::SetCookie>> cookies_from_context (JSContext* ctx) {
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        JS_ThrowInternalError (ctx, "No response available");
        return std::nullopt;
    }
    auto it = data->response->headers.find ("set-cookie");
    if (it == data->response->headers.end ()) {
        return std::vector<vayu::http::SetCookie>{};
    }
    return vayu::http::parse_set_cookie (it->second);
}

// A cookie name is a non-empty string or nothing - the same rule the header
// methods apply, for the same reason: coercing a number would invent a name.
std::optional<std::string>
read_cookie_name_arg (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString (argv[0])) {
        JS_ThrowTypeError (ctx, "cookies.%s(name) needs a cookie name string, got %s",
        member, argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
        return std::nullopt;
    }
    std::string name = js_to_string (ctx, argv[0]);
    if (name.empty ()) {
        JS_ThrowTypeError (ctx, "cookies.%s(name) needs a non-empty cookie name", member);
        return std::nullopt;
    }
    return name;
}

JSValue js_cookies_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto name = read_cookie_name_arg (ctx, "get", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto cookies = cookies_from_context (ctx);
    if (!cookies) {
        return JS_EXCEPTION;
    }
    const auto* cookie = find_cookie (*cookies, *name);
    // Postman answers undefined for an absent cookie; a throw would make the
    // common `if (cookies.get(x))` guard unwritable.
    return cookie ? JS_NewString (ctx, cookie->value.c_str ()) : JS_UNDEFINED;
}

JSValue js_cookies_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto name = read_cookie_name_arg (ctx, "has", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto cookies = cookies_from_context (ctx);
    if (!cookies) {
        return JS_EXCEPTION;
    }
    return JS_NewBool (ctx, find_cookie (*cookies, *name) != nullptr);
}

JSValue js_cookies_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto cookies = cookies_from_context (ctx);
    if (!cookies) {
        return JS_EXCEPTION;
    }
    // Plain assignment, so a name set twice ends on its last value - the same
    // answer get() gives.
    JSValue obj = JS_NewObject (ctx);
    for (const auto& cookie : *cookies) {
        JS_SetPropertyStr (ctx, obj, cookie.name.c_str (),
        JS_NewString (ctx, cookie.value.c_str ()));
    }
    return obj;
}

JSValue create_cookie_list (JSContext* ctx, const std::vector<vayu::http::SetCookie>& cookies) {
    JSValue list = JS_NewArray (ctx);
    if (JS_IsException (list)) {
        return list;
    }

    uint32_t index = 0;
    for (const auto& cookie : cookies) {
        JSValue entry = JS_NewObject (ctx);
        JS_SetPropertyStr (ctx, entry, "name", JS_NewString (ctx, cookie.name.c_str ()));
        JS_SetPropertyStr (ctx, entry, "value", JS_NewString (ctx, cookie.value.c_str ()));
        JSValue attrs       = JS_NewArray (ctx);
        uint32_t attr_index = 0;
        for (const auto& attr : cookie.attrs) {
            JS_SetPropertyUint32 (
            ctx, attrs, attr_index++, JS_NewString (ctx, attr.c_str ()));
        }
        JS_SetPropertyStr (ctx, entry, "attrs", attrs);
        JS_SetPropertyUint32 (ctx, list, index++, entry);
    }

    JS_DefinePropertyValueStr (ctx, list, "get",
    JS_NewCFunction (ctx, js_cookies_get, "get", 1), COOKIE_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, list, "has",
    JS_NewCFunction (ctx, js_cookies_has, "has", 1), COOKIE_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, list, "toObject",
    JS_NewCFunction (ctx, js_cookies_to_object, "toObject", 0), COOKIE_METHOD_FLAGS);
    return list;
}

// pm.response.cookies - the response's Set-Cookie header, parsed.
//
// Registered as a getter that replaces itself with the parsed list on first
// read. A load run executes a test script per completed request, and eager
// parsing would charge every one of them for a header no script asked about;
// caching the result keeps `pm.response.cookies[0] === pm.response.cookies[0]`
// true within a script, which a fresh array per access would not.
JSValue js_response_cookies (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto cookies = cookies_from_context (ctx);
    if (!cookies) {
        return JS_EXCEPTION;
    }
    JSValue list = create_cookie_list (ctx, *cookies);
    if (JS_IsException (list)) {
        return list;
    }
    if (JS_IsObject (this_val)) {
        if (JS_DefinePropertyValueStr (ctx, this_val, "cookies",
            JS_DupValue (ctx, list), JS_PROP_C_W_E) < 0) {
            // Caching is an optimisation - a rejected redefinition must not
            // fail the read the script actually asked for.
            JS_FreeValue (ctx, JS_GetException (ctx));
        }
    }
    return list;
}

/**
 * Bind the streamed response's event list and its two markers onto
 * `pm.response`, or bind nothing at all (issue #575).
 *
 * Three properties, one arrival set: `events` is the bounded stored list,
 * `totalEvents` is how many the stream actually received, and
 * `eventsTruncated` says whether the two differ. A script that asserts over a
 * prefix believing it has the whole stream is the failure this exists to make
 * impossible, so the markers are never optional decoration - they are bound
 * with the list or the list is not bound.
 *
 * Absent, not empty, for a non-stream response: `typeof pm.response.events`
 * separates "not a stream" from "a stream with no events", which an empty
 * array could not. Same rule as `pm.request.body` and `pm.iterationData`.
 *
 * Entries are `{ event, id?, data, dataTruncated? }`. The stored node spells
 * the upstream id `sourceId` because a relay frame id sits beside it there;
 * inside a script there is only one id to mean, so it is `id`. `id` is absent
 * when the origin sent none, rather than `""` - a script comparing ids must be
 * able to see that there was nothing to compare.
 */
void install_response_events (JSContext* ctx, JSValue response, const nlohmann::json* node) {
    if (!node || !node->is_object ()) {
        return;
    }

    JSValue events       = JS_NewArray (ctx);
    uint32_t index       = 0;
    const auto items     = node->find ("items");
    const bool has_items = items != node->end () && items->is_array ();
    if (has_items) {
        for (const auto& item : *items) {
            if (!item.is_object ()) {
                continue;
            }
            JSValue entry = JS_NewObject (ctx);
            const std::string name = item.value ("event", std::string ("message"));
            JS_SetPropertyStr (ctx, entry, "event",
            JS_NewStringLen (ctx, name.data (), name.size ()));
            const std::string data = item.value ("data", std::string ());
            JS_SetPropertyStr (ctx, entry, "data",
            JS_NewStringLen (ctx, data.data (), data.size ()));
            if (const auto source_id = item.find ("sourceId");
            source_id != item.end () && source_id->is_string ()) {
                const auto id = source_id->get<std::string> ();
                JS_SetPropertyStr (
                ctx, entry, "id", JS_NewStringLen (ctx, id.data (), id.size ()));
            }
            // Per-event truncation is disclosed in band exactly as the stored
            // node discloses it: an event whose data is a prefix must never
            // read as a whole one.
            if (item.value ("dataTruncated", false)) {
                JS_SetPropertyStr (ctx, entry, "dataTruncated", JS_NewBool (ctx, 1));
            }
            JS_SetPropertyUint32 (ctx, events, index++, entry);
        }
    }

    JS_SetPropertyStr (ctx, response, "events", events);
    JS_SetPropertyStr (ctx, response, "totalEvents",
    JS_NewInt64 (ctx, node->value ("totalEvents", static_cast<int64_t> (index))));
    JS_SetPropertyStr (ctx, response, "eventsTruncated",
    JS_NewBool (ctx, node->value ("eventsTruncated", false) ? 1 : 0));
}

void setup_pm_response (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    // Free old response object if it exists to prevent memory leak
    JSValue old_response = JS_GetPropertyStr (ctx, pm, "response");
    if (!JS_IsUndefined (old_response)) {
        JS_FreeValue (ctx, old_response);
    }

    JSValue response = JS_NewObject (ctx);

    if (data && data->response) {
        // pm.response.code
        JS_SetPropertyStr (
        ctx, response, "code", JS_NewInt32 (ctx, data->response->status_code));

        // pm.response.status (same as code for compatibility)
        JS_SetPropertyStr (
        ctx, response, "status", JS_NewInt32 (ctx, data->response->status_code));

        // pm.response.responseTime - perceived latency (submit → completion),
        // includes generator-side queue wait. For pure server time, use
        // responseTimeWire. queue_wait_ms is exposed as responseTimeQueueWait.
        JS_SetPropertyStr (ctx, response, "responseTime",
        JS_NewFloat64 (ctx, data->response->timing.total_ms));
        JS_SetPropertyStr (ctx, response, "responseTimeWire",
        JS_NewFloat64 (ctx, data->response->timing.wire_ms));
        JS_SetPropertyStr (ctx, response, "responseTimeQueueWait",
        JS_NewFloat64 (ctx, data->response->timing.queue_wait_ms));

        // Error information (for client-side failures)
        if (data->response->error_code != vayu::ErrorCode::None) {
            JS_SetPropertyStr (ctx, response, "errorCode",
            JS_NewString (ctx, vayu::to_string (data->response->error_code)));
            JS_SetPropertyStr (ctx, response, "errorMessage",
            JS_NewString (ctx, data->response->error_message.c_str ()));
        }

        // pm.response.json() and pm.response.text()
        install_response_body_readers (ctx, response, data->response->body);

        // pm.response.reason()
        JS_SetPropertyStr (ctx, response, "reason",
        JS_NewCFunction (ctx, js_response_reason, "reason", 0));

        // pm.response.size()
        JS_SetPropertyStr (ctx, response, "size",
        JS_NewCFunction (ctx, js_response_size, "size", 0));

        // pm.response.headers - a plain object with get()/has() over it. No
        // mutators: the response has already arrived, so a header method that
        // appeared to change it would be a lie.
        JSValue headers = JS_NewObject (ctx);
        install_header_methods (ctx, headers, /*mutators=*/false);
        for (const auto& [key, value] : data->response->headers) {
            define_header_entry (ctx, headers, key, value);
        }
        JS_SetPropertyStr (ctx, response, "headers", headers);

        // pm.response.cookies - a getter, so a script that never mentions
        // cookies never pays for the parse. Configurable because the getter
        // replaces itself with the list it built.
        JSAtom cookies_atom = JS_NewAtom (ctx, "cookies");
        // Enumerable like every other member of pm.response, so
        // console.log(pm.response) and JSON.stringify show it rather than
        // hiding a documented property behind its own laziness.
        JS_DefinePropertyGetSet (ctx, response, cookies_atom,
        JS_NewCFunction (ctx, js_response_cookies, "cookies", 0), JS_UNDEFINED,
        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
        JS_FreeAtom (ctx, cookies_atom);

        // pm.response.events / totalEvents / eventsTruncated - a streamed run
        // only. Bound together or not at all: a script that reads the list
        // without its markers cannot tell a whole stream from its prefix, and
        // the three are one fact about one arrival set.
        install_response_events (ctx, response, data->response_events);

        // pm.response.to.have chain for Postman-compatible assertions
        JS_SetPropertyStr (ctx, response, "to", create_response_to_object (ctx));
    }

    JS_SetPropertyStr (ctx, pm, "response", response);
}

/**
 * The string `pm.request.body` shows, and the yardstick the write-back measures
 * an edit against - one function so the two cannot disagree about what a body
 * looks like as a string.
 *
 * For a content mode it is the content itself. For `x-www-form-urlencoded` it
 * is the exact wire body. For `form-data` it is a rendering of the parts and
 * *not* the bytes sent: a multipart envelope carries a boundary libcurl
 * generates at transfer time, so no faithful string exists before the send.
 * Reading `content` alone - which is what this replaced - handed every form
 * body `""`, indistinguishable from a request with no body at all.
 *
 * The two form modes take different renderers because only one of them is
 * reversible: the urlencoded view *is* the wire body and parses straight back
 * through `parse_urlencoded`, so it must stay a plain `key=value` list, while
 * form-data names its file parts (`key=@filename`) because encoding one as a
 * pair loses it (issue #411). A file part is only ever valid under form-data,
 * so this split costs the urlencoded body nothing.
 */
std::string script_body_view (const Body& body) {
    if (body.mode == BodyMode::FormData) {
        return vayu::http::render_form_data_parts (body.fields);
    }
    return body.mode == BodyMode::Form ? vayu::http::encode_urlencoded (body.fields) :
                                         body.content;
}

/**
 * Which header map `pm.request.headers` shows.
 *
 * Two records of "the request's headers" exist and they are not the same set
 * (issue #483). `request->headers` is what the request was *composed* with;
 * `response->request_headers` is what was *sent* - that same map minus the
 * headers the transfer suppresses, plus the ones the engine derives at curl
 * setup: the body-implied `Content-Type` (GraphQL -> `application/json`, Form
 * -> `application/x-www-form-urlencoded`) and the default `User-Agent`. A test
 * script asking which Content-Type went out for a GraphQL body is asking about
 * the second, and the composed map structurally cannot answer - nobody wrote
 * that header down, the engine derived it precisely so the user would not have
 * to. It read `undefined` and the assertion went red on a request that went
 * out right.
 *
 * So a **test** script reads the sent record and a **pre-request** script reads
 * the composed map. That split is forced, not preferred: before the send there
 * is no sent record to read, and the pre-request object is the one
 * `apply_pm_request_writeback` applies back onto the request, so showing it
 * anything other than the composed set would make `delete` operate on headers
 * the request never carried.
 *
 * The fallback is load-bearing rather than defensive padding. A load run's
 * deferred validation rebuilds its `Response` from a sampled response
 * (`run_manager.cpp`), which records no sent headers at all; seeding from that
 * empty map would take `pm.request.headers` from "missing the two derived
 * entries" to "empty", a worse answer than the one this fixes. An empty sent
 * record means nothing was recorded, never that nothing was sent.
 */
const Headers& script_request_header_view (const ContextData& data) {
    if (data.response != nullptr && !data.response->request_headers.empty ()) {
        return data.response->request_headers;
    }
    return data.request->headers;
}

// ============================================================================
// pm.request.url - the Url object's members
// ============================================================================

void build_request_url_members (JSContext* ctx, JSValue url, RequestUrlState& state);

// `this` is the Url object every one of these was reached through. A method
// pulled off it and called bare has no state, which is a script error rather
// than an engine one - the same rule the header methods follow.
//
// The parts are built here rather than assumed: today the only way a script can
// hold this object is through the accessor, which builds - but `getHost()`
// reading unbuilt parts would answer `""` for a real host, and a rule that
// holds only because of how the object is reached today is one a later change
// breaks silently. Built already, this costs a branch.
RequestUrlState* url_state_of_this (JSContext* ctx, JSValueConst this_val, const char* member) {
    auto* state = request_url_state (this_val);
    if (!state) {
        JS_ThrowTypeError (ctx, "pm.request.url.%s must be called on the URL object, not detached from it",
        member);
        return nullptr;
    }
    if (!state->built) {
        build_request_url_members (ctx, this_val, *state);
    }
    // And up to date with the arrays a script may have mutated since. Without
    // this, `path.push(...)` followed by `getPath()` in the same script reads
    // the parts as they were parsed and answers the pre-edit path - the reads
    // have to follow the writes, or a script that edits and then signs would
    // sign a URL it is not sending.
    if (auto reason = refresh_url_from_members (ctx, this_val, *state)) {
        JS_ThrowTypeError (ctx, "%s", reason->c_str ());
        return nullptr;
    }
    return state;
}

/**
 * The whole URL, and the single answer behind every string context.
 *
 * `toString`, `valueOf`, `toJSON` and `@@toPrimitive` all land here, so
 * concatenation, a template literal, `==` against a string, `JSON.stringify`
 * and `String.prototype`'s generic methods (which coerce through
 * `ToString(this)`) keep behaving the way they did when this was a string.
 * `@@toPrimitive`'s hint argument is ignored on purpose: a URL has one
 * primitive form, and answering a number hint with anything else would make
 * `+url` a different kind of surprise.
 */
JSValue js_url_to_string (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = url_state_of_this (ctx, this_val, "toString");
    if (!state) {
        return JS_EXCEPTION;
    }
    return JS_NewStringLen (ctx, state->text.data (), state->text.size ());
}

/// `getHost()` / `getPath()` / `getQueryString()`, told apart by their magic -
/// three readers of the same state that differ only in which part they join.
enum UrlPartGetter : int { URL_GET_HOST, URL_GET_PATH, URL_GET_QUERY_STRING };

JSValue
js_url_part_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)argc;
    (void)argv;
    const char* member = magic == URL_GET_HOST ? "getHost" :
    magic == URL_GET_PATH                      ? "getPath" :
                                                 "getQueryString";
    auto* state        = url_state_of_this (ctx, this_val, member);
    if (!state) {
        return JS_EXCEPTION;
    }
    std::string out;
    switch (magic) {
    case URL_GET_HOST: out = vayu::http::join_host (state->parts.host); break;
    case URL_GET_PATH: out = vayu::http::join_path (state->parts.path); break;
    default: out = state->parts.query; break;
    }
    return JS_NewStringLen (ctx, out.data (), out.size ());
}

/**
 * `url.update(newUrl)` - Postman's spelling of a whole-URL write, and the same
 * write `pm.request.url = '...'` performs.
 *
 * Mutates in place rather than handing back a new object, because Postman's
 * does: a script that held a reference to the URL before the update has to see
 * the update through it, or the write-back and the script disagree about what
 * is being sent. Member mutation (pushing to `path`, editing a query member) is
 * out of scope for v1 and documented as such.
 */
JSValue js_url_update (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = url_state_of_this (ctx, this_val, "update");
    if (!state) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "pm.request.url.update needs a URL string");
    }
    auto text = script_url_text (ctx, argv[0]);
    if (!text) {
        return JS_ThrowTypeError (ctx, "pm.request.url.update needs a URL string, got %s",
        js_type_name (ctx, argv[0]));
    }
    state->text = std::move (*text);
    build_request_url_members (ctx, this_val, *state);
    return JS_UNDEFINED;
}

/// The Url object a query method was bound to. Query methods hang off
/// `url.query`, so `this` is that sub-object and the URL comes through the
/// bound data instead - one source of truth for the parsed params rather than a
/// second copy living on the query object.
RequestUrlState* url_state_of_query (JSContext* ctx, JSValue* func_data, const char* member) {
    auto* state = request_url_state (func_data[0]);
    if (!state) {
        JS_ThrowInternalError (ctx, "pm.request.url.query.%s lost its URL", member);
        return nullptr;
    }
    // Same reason the url's own methods refresh: a `path.push` before a
    // `query.get` must not leave the two members describing different URLs.
    if (auto reason = refresh_url_from_members (ctx, func_data[0], *state)) {
        JS_ThrowTypeError (ctx, "%s", reason->c_str ());
        return nullptr;
    }
    return state;
}

/// The value of the first param named @p name, or nullptr when there is none.
const std::optional<std::string>*
find_query_param (const RequestUrlState& state, const std::string& name) {
    for (const auto& param : state.parts.query_params) {
        if (param.key == name) {
            return &param.value;
        }
    }
    return nullptr;
}

/**
 * `query.get(name)` - the *first* match's value, `null` when the name is absent
 * and `null` for a bare `?flag` that carries no value.
 *
 * First rather than last: postman-collection's `PropertyList.one` answers with
 * the first, and a duplicated query key is exactly where a "last wins" guess
 * would silently sign the wrong string. `toObject()` is the last-wins view, and
 * it says so.
 */
JSValue js_url_query_get (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    auto* state = url_state_of_query (ctx, func_data, magic == 0 ? "get" : "has");
    if (!state) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "pm.request.url.query.%s needs a name string, got %s", magic == 0 ? "get" : "has",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    const std::string name = js_to_string (ctx, argv[0]);
    const auto* found      = find_query_param (*state, name);
    if (magic != 0) {
        return JS_NewBool (ctx, found != nullptr ? 1 : 0);
    }
    if (!found || !found->has_value ()) {
        return JS_NULL;
    }
    return JS_NewStringLen (ctx, (*found)->data (), (*found)->size ());
}

/// One `{ key, value }`, with a bare key's value as `null` - the distinction
/// between `?flag` and `?flag=` survives into the script.
JSValue query_param_entry (JSContext* ctx, const vayu::http::UrlQueryParam& param) {
    JSValue entry = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, entry, "key",
    JS_NewStringLen (ctx, param.key.data (), param.key.size ()));
    JS_SetPropertyStr (ctx, entry, "value",
    param.value ? JS_NewStringLen (ctx, param.value->data (), param.value->size ()) : JS_NULL);
    return entry;
}

/**
 * `query.all()` - every param, in wire order, duplicates kept.
 *
 * The canonicalization workhorse this whole issue exists for: an HMAC over a
 * sorted query has to see the parameters as they were sent, which is the one
 * view a `{name: value}` map cannot give.
 */
JSValue js_url_query_all (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "all");
    if (!state) {
        return JS_EXCEPTION;
    }
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& param : state->parts.query_params) {
        JS_SetPropertyUint32 (ctx, list, next++, query_param_entry (ctx, param));
    }
    return list;
}

/// `query.toObject()` - last wins, because that is what a plain object can say.
/// `all()` is the view that keeps duplicates.
JSValue js_url_query_to_object (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "toObject");
    if (!state) {
        return JS_EXCEPTION;
    }
    JSValue out = JS_NewObject (ctx);
    for (const auto& param : state->parts.query_params) {
        JS_SetPropertyStr (ctx, out, param.key.c_str (),
        param.value ? JS_NewStringLen (ctx, param.value->data (), param.value->size ()) : JS_NULL);
    }
    return out;
}

JSValue js_url_query_count (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "count");
    if (!state) {
        return JS_EXCEPTION;
    }
    return JS_NewInt32 (ctx, static_cast<int32_t> (state->parts.query_params.size ()));
}

/**
 * @brief Refuse a member edit on a URL that has no members (issue #1040).
 *
 * `parse_url_parts` leaves every part empty for a URL libcurl cannot read, so a
 * write there would compose a plausible URL out of nothing - `://` and whatever
 * was pushed - and send it. There is no honest edit to make, so it is an error
 * rather than a no-op.
 */
bool require_parsed_url (JSContext* ctx, const RequestUrlState& state, const char* member) {
    if (state.parts.parsed) {
        return true;
    }
    JS_ThrowTypeError (ctx,
    "pm.request.url.%s cannot be edited: \"%s\" could not be parsed as a URL. "
    "Assign a whole URL instead.",
    member, state.text.c_str ());
    return false;
}

/// A member write happened, so the parts are ahead of the text. What follows
/// from that - recomposing the raw query string and the URL - is
/// `refresh_url_from_members`' job, at the moment someone needs the whole URL.
void mark_url_edited (RequestUrlState& state) {
    state.dirty = true;
}

/// One `{key, value}` argument of a query writer, read the way `all()` hands
/// them back. A missing `value` is a bare key, which is the `?flag` form.
bool read_query_param_arg (JSContext* ctx,
JSValueConst arg,
const char* member,
vayu::http::UrlQueryParam& out) {
    if (!JS_IsObject (arg) || JS_IsArray (arg) || JS_IsFunction (ctx, arg)) {
        JS_ThrowTypeError (ctx, "pm.request.url.query.%s needs a { key, value } object, got %s",
        member, js_type_name (ctx, arg));
        return false;
    }
    ScopedValue key (ctx, JS_GetPropertyStr (ctx, arg, "key"));
    if (!JS_IsString (key.get ())) {
        JS_ThrowTypeError (ctx, "pm.request.url.query.%s needs a string key, got %s",
        member, js_type_name (ctx, key.get ()));
        return false;
    }
    out.key = js_to_string (ctx, key.get ());
    if (out.key.empty ()) {
        JS_ThrowTypeError (ctx, "pm.request.url.query.%s needs a non-empty key", member);
        return false;
    }
    ScopedValue value (ctx, JS_GetPropertyStr (ctx, arg, "value"));
    if (JS_IsUndefined (value.get ()) || JS_IsNull (value.get ())) {
        out.value = std::nullopt; // a bare `?key`
        return true;
    }
    if (!JS_IsString (value.get ()) && !JS_IsNumber (value.get ()) &&
    !JS_IsBool (value.get ())) {
        JS_ThrowTypeError (ctx, "pm.request.url.query.%s value must be a string, number, boolean or null, got %s",
        member, js_type_name (ctx, value.get ()));
        return false;
    }
    out.value = js_to_string (ctx, value.get ());
    return true;
}

/// `add` appends even when the key is already there - a query may repeat a key,
/// and `all()` exists because of it. `upsert` is the "one of these" spelling:
/// it replaces the first match in place, keeping wire position, and appends
/// when there is none.
enum QueryWriter : int { QUERY_ADD, QUERY_UPSERT };

JSValue js_url_query_add (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    const char* member = magic == QUERY_ADD ? "add" : "upsert";
    auto* state        = url_state_of_query (ctx, func_data, member);
    if (!state || !require_parsed_url (ctx, *state, "query")) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_ThrowTypeError (
        ctx, "pm.request.url.query.%s needs a { key, value } object", member);
    }
    vayu::http::UrlQueryParam param;
    if (!read_query_param_arg (ctx, argv[0], member, param)) {
        return JS_EXCEPTION;
    }
    auto& params = state->parts.query_params;
    if (magic == QUERY_UPSERT) {
        for (auto& existing : params) {
            if (existing.key == param.key) {
                existing.value = std::move (param.value);
                mark_url_edited (*state);
                return JS_UNDEFINED;
            }
        }
    }
    params.push_back (std::move (param));
    mark_url_edited (*state);
    return JS_UNDEFINED;
}

/// `remove(name)` takes **every** parameter of that name, not the first: a
/// caller removing `page` and getting one of two back has removed nothing they
/// can observe, and would have to loop to find that out.
JSValue js_url_query_remove (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "remove");
    if (!state || !require_parsed_url (ctx, *state, "query")) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "pm.request.url.query.remove needs a name string, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    const std::string name = js_to_string (ctx, argv[0]);
    auto& params           = state->parts.query_params;
    const size_t before    = params.size ();
    std::erase_if (params,
    [&name] (const vayu::http::UrlQueryParam& p) { return p.key == name; });
    // Removing a name that is not there is a no-op rather than an error, the
    // same rule `pm.request.headers.remove` follows.
    if (params.size () != before) {
        mark_url_edited (*state);
    }
    return JS_UNDEFINED;
}

JSValue js_url_query_clear (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "clear");
    if (!state || !require_parsed_url (ctx, *state, "query")) {
        return JS_EXCEPTION;
    }
    if (!state->parts.query_params.empty ()) {
        state->parts.query_params.clear ();
        mark_url_edited (*state);
    }
    return JS_UNDEFINED;
}

/// The `query` sub-object: the params as an array plus the PropertyList reads
/// over them, each bound to @p url so the two can never describe different
/// URLs.
JSValue build_query_object (JSContext* ctx, JSValue url, const RequestUrlState& state) {
    JSValue query = JS_NewObject (ctx);

    struct QueryMethod {
        const char* name;
        JSCFunctionData* fn;
        int length;
        int magic;
    };
    static constexpr std::array<QueryMethod, 9> METHODS = {
        QueryMethod{ "get", js_url_query_get, 1, 0 },
        QueryMethod{ "has", js_url_query_get, 1, 1 },
        QueryMethod{ "all", js_url_query_all, 0, 0 },
        QueryMethod{ "toObject", js_url_query_to_object, 0, 0 },
        QueryMethod{ "count", js_url_query_count, 0, 0 },
        QueryMethod{ "add", js_url_query_add, 1, QUERY_ADD },
        QueryMethod{ "upsert", js_url_query_add, 1, QUERY_UPSERT },
        QueryMethod{ "remove", js_url_query_remove, 1, 0 },
        QueryMethod{ "clear", js_url_query_clear, 0, 0 },
    };
    for (const auto& method : METHODS) {
        JS_SetPropertyStr (ctx, query, method.name,
        JS_NewCFunctionData (ctx, method.fn, method.length, method.magic, 1, &url));
    }

    // Deliberately no `members` array beside them. Postman's PropertyList has
    // one, but a copy of it here would be a second view of the same params
    // that no doc names and no completion offers - and `all()` is that view,
    // documented. The real PropertyList is a list of QueryParam objects with
    // their own methods, which is more than v1 ships either way.
    return query;
}

/// A JS array of strings, for the two parts Postman presents as segment lists.
JSValue string_array (JSContext* ctx, const std::vector<std::string>& values) {
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& value : values) {
        JS_SetPropertyUint32 (
        ctx, list, next++, JS_NewStringLen (ctx, value.data (), value.size ()));
    }
    return list;
}

/**
 * @brief Parse `state.text` and (re)define the members a script reads.
 *
 * Called on the first read of `pm.request.url` and again after every write to
 * it, so the members and the string can never disagree. Redefining rather than
 * patching: a URL with no fragment must not keep the previous URL's `hash`.
 *
 * A URL libcurl cannot parse leaves every part empty (see `parse_url_parts`)
 * and the string intact. That is deliberate: `toString()` still answers, so a
 * script reading the whole URL is unaffected, while a script reading parts of
 * an unparseable URL gets nothing rather than a plausible half.
 */
/// Which single-string part an accessor reads and writes.
enum UrlStringPart : int { URL_PART_PROTOCOL, URL_PART_PORT, URL_PART_HASH };

const char* url_string_part_name (int magic) {
    return magic == URL_PART_PROTOCOL ? "protocol" :
    magic == URL_PART_PORT            ? "port" :
                                        "hash";
}

std::string& url_string_part (RequestUrlState& state, int magic) {
    return magic == URL_PART_PROTOCOL ? state.parts.protocol :
    magic == URL_PART_PORT            ? state.parts.port :
                                        state.parts.hash;
}

JSValue js_url_string_part_get (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* state = request_url_state (func_data[0]);
    if (!state) {
        return JS_ThrowInternalError (ctx, "pm.request.url part lost its URL");
    }
    const std::string& value = url_string_part (*state, magic);
    return JS_NewStringLen (ctx, value.data (), value.size ());
}

/**
 * `url.protocol = 'http'`, `url.port = '8443'`, `url.hash = 'top'`.
 *
 * Accessors rather than plain data properties for the reason the segment lists
 * are proxies: a writable data property would take the assignment and reach
 * nothing. There is no read-only-member case to preserve here - a test script's
 * pm.request is a record nothing writes back, which is a property of the hook,
 * not of the member.
 */
JSValue js_url_string_part_set (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    auto* state = request_url_state (func_data[0]);
    if (!state) {
        return JS_ThrowInternalError (ctx, "pm.request.url part lost its URL");
    }
    const char* member = url_string_part_name (magic);
    if (!require_parsed_url (ctx, *state, member)) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || (!JS_IsString (argv[0]) && !JS_IsNumber (argv[0]))) {
        return JS_ThrowTypeError (ctx, "pm.request.url.%s must be assigned a string, got %s",
        member, argc < 1 ? "no value" : js_type_name (ctx, argv[0]));
    }
    std::string value = js_to_string (ctx, argv[0]);
    if (magic == URL_PART_PROTOCOL && value.empty ()) {
        // Every other part may legitimately be cleared; a URL with no scheme is
        // one `parse_url_parts` would refuse to read back.
        return JS_ThrowTypeError (ctx, "pm.request.url.protocol must not be empty");
    }
    url_string_part (*state, magic) = std::move (value);
    mark_url_edited (*state);
    return JS_UNDEFINED;
}

/// `url.length` - the current URL's length, and read-only. A setter that threw
/// would be noise; one that silently accepted would be the defect this whole
/// issue is about, so the property simply has no setter and an assignment is
/// the ordinary JavaScript no-op for that.
JSValue js_url_length_get (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    auto* state = request_url_state (func_data[0]);
    if (!state) {
        return JS_ThrowInternalError (ctx, "pm.request.url lost its URL");
    }
    if (auto reason = refresh_url_from_members (ctx, func_data[0], *state)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }
    return JS_NewInt64 (ctx, static_cast<int64_t> (state->text.size ()));
}

void build_request_url_members (JSContext* ctx, JSValue url, RequestUrlState& state) {
    state.parts = vayu::http::parse_url_parts (state.text);
    state.built = true;
    state.dirty = false;

    // **Defined, not set.** The prototype here is `String.prototype`, which is
    // itself a String object holding "" - so it carries a non-writable own
    // `length`, and a plain `JS_SetPropertyStr` (which is `[[Set]]`, and walks
    // the chain) is *refused* by it. Defining puts the property on this object
    // and never consults the prototype, which is what every member wants
    // anyway: these are the URL's own facts, not writes through to something.
    const auto define = [&] (const char* name, JSValue value) {
        JS_DefinePropertyValueStr (ctx, url, name, value, JS_PROP_C_W_E);
    };
    // The single-string parts are accessors so an assignment reaches the URL
    // instead of replacing the property with a value nothing reads (#1040).
    const auto define_accessor = [&] (const char* name, JSCFunctionData* getter,
                                 JSCFunctionData* setter, int magic) {
        JSAtom atom = JS_NewAtom (ctx, name);
        JS_DefinePropertyGetSet (ctx, url, atom,
        JS_NewCFunctionData (ctx, getter, 0, magic, 1, &url),
        setter != nullptr ? JS_NewCFunctionData (ctx, setter, 1, magic, 1, &url) : JS_UNDEFINED,
        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
        JS_FreeAtom (ctx, atom);
    };
    define_accessor ("protocol", js_url_string_part_get, js_url_string_part_set,
    URL_PART_PROTOCOL);
    define_accessor ("port", js_url_string_part_get, js_url_string_part_set, URL_PART_PORT);
    define_accessor ("hash", js_url_string_part_get, js_url_string_part_set, URL_PART_HASH);
    // `length` is defined rather than left as one of the documented breaks,
    // because the alternative is not "absent": inherited from that same String
    // prototype it answers `0` - a plausible number for a URL that is not
    // empty, which is the silent-wrong-answer class this program exists to
    // close. One property, and `url.length` means what it always did.
    define_accessor ("length", js_url_length_get, nullptr, 0);
    // Plain arrays, not accessors and not proxies: `pm.request.headers` is
    // already the object the write-back *reads back*, and the same rule answers
    // every spelling of a segment edit at once - push, splice, index
    // assignment, a length truncation, or replacing the array outright. A
    // proxy would have intercepted each write instead, and `JS_IsArray`
    // answers on the class id, so `pm.expect(url.host).to.include(...)` would
    // have stopped seeing an array at all. See `refresh_url_from_members`.
    define ("host", string_array (ctx, state.parts.host));
    define ("path", string_array (ctx, state.parts.path));
    define ("query", build_query_object (ctx, url, state));
}

/// The well-known symbol, reached through the `Symbol` global because QuickJS
/// does not export its atom.
JSAtom well_known_symbol_atom (JSContext* ctx, const char* name) {
    JSValue global = JS_GetGlobalObject (ctx);
    JSValue symbol = JS_GetPropertyStr (ctx, global, "Symbol");
    JSValue member = JS_GetPropertyStr (ctx, symbol, name);
    JSAtom atom    = JS_ValueToAtom (ctx, member);
    JS_FreeValue (ctx, member);
    JS_FreeValue (ctx, symbol);
    JS_FreeValue (ctx, global);
    return atom;
}

/// A fresh Url object holding @p text, with its members not yet built.
JSValue new_request_url (JSContext* ctx, std::string text) {
    JSValue url = JS_NewObjectClass (ctx, request_url_class_id);
    if (JS_IsException (url)) {
        return url;
    }
    auto* state = new RequestUrlState{ std::move (text), {}, false };
    if (JS_SetOpaque (url, state) < 0) {
        // The object is not of this class, so the finalizer will never run and
        // nothing else would free the state.
        delete state;
        JS_FreeValue (ctx, url);
        return JS_EXCEPTION;
    }

    // Defined rather than set, for the reason build_request_url_members gives:
    // `String.prototype` is the prototype here, and `[[Set]]` consults it.
    const auto define = [&] (const char* name, JSValue value) {
        JS_DefinePropertyValueStr (ctx, url, name, value, JS_PROP_C_W_E);
    };
    define ("toString", JS_NewCFunction (ctx, js_url_to_string, "toString", 0));
    define ("valueOf", JS_NewCFunction (ctx, js_url_to_string, "valueOf", 0));
    define ("toJSON", JS_NewCFunction (ctx, js_url_to_string, "toJSON", 0));
    JSAtom to_primitive = well_known_symbol_atom (ctx, "toPrimitive");
    JS_DefinePropertyValue (ctx, url, to_primitive,
    JS_NewCFunction (ctx, js_url_to_string, "[Symbol.toPrimitive]", 1), JS_PROP_CONFIGURABLE);
    JS_FreeAtom (ctx, to_primitive);

    define ("update", JS_NewCFunction (ctx, js_url_update, "update", 1));
    for (const auto& [name, magic] :
    std::array<std::pair<const char*, int>, 3>{ { { "getHost", URL_GET_HOST },
    { "getPath", URL_GET_PATH }, { "getQueryString", URL_GET_QUERY_STRING } } }) {
        define (name,
        JS_NewCFunctionMagic (ctx, js_url_part_getter, name, 0, JS_CFUNC_generic_magic, magic));
    }
    return url;
}

/// The Url object behind the accessor, with its members materialised.
JSValue bound_request_url (JSContext* ctx, JSValue* func_data) {
    auto* state = request_url_state (func_data[0]);
    if (state && !state->built) {
        build_request_url_members (ctx, func_data[0], *state);
    }
    return JS_DupValue (ctx, func_data[0]);
}

JSValue js_request_url_get (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    return bound_request_url (ctx, func_data);
}

/**
 * `pm.request.url = '...'` - the write that shipped, still working, still
 * feeding `apply_pm_request_writeback`.
 *
 * Refuses anything that is neither a string nor a Url object *at the assignment
 * itself*, rather than letting the write-back reject it several lines later:
 * the script author is told which line was wrong, and a test script - which has
 * no write-back to be rejected by - stops silently accepting a number.
 */
JSValue js_request_url_set (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)magic;
    auto text = argc > 0 ? script_url_text (ctx, argv[0]) : std::nullopt;
    if (!text) {
        return JS_ThrowTypeError (ctx,
        "pm.request.url must be assigned a URL string, got %s (call "
        ".toString() "
        "on a value that is not one)",
        argc > 0 ? js_type_name (ctx, argv[0]) : "no value");
    }
    auto* state = request_url_state (func_data[0]);
    if (!state) {
        return JS_ThrowInternalError (ctx, "pm.request.url lost its URL");
    }
    state->text = std::move (*text);
    build_request_url_members (ctx, func_data[0], *state);
    return JS_UNDEFINED;
}

/**
 * @brief Install `pm.request.url` as the accessor pair over a Url object.
 *
 * An accessor rather than a plain member for two reasons. The parse is paid on
 * the first *read*, so a script that never mentions the URL - most scripts -
 * costs one object allocation and nothing else. And a write goes through the
 * setter, so `pm.request.url = 'https://...'` leaves a Url object behind rather
 * than replacing the object with a bare string, which is what would make
 * `pm.request.url = x; pm.request.url.query.get('a')` throw.
 *
 * Enumerable, like every other member of `pm.request`: `JSON.stringify` and
 * `console.log` have to keep showing the URL, and the object's own `toJSON`
 * makes that the string it always was.
 */
void install_request_url (JSContext* ctx, JSValue request, const std::string& url_text) {
    JSValue url = new_request_url (ctx, url_text);
    if (JS_IsException (url)) {
        JS_FreeValue (ctx, url);
        return;
    }
    JSAtom atom = JS_NewAtom (ctx, "url");
    JS_DefinePropertyGetSet (ctx, request, atom,
    JS_NewCFunctionData (ctx, js_request_url_get, 0, 0, 1, &url),
    JS_NewCFunctionData (ctx, js_request_url_set, 1, 0, 1, &url),
    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom (ctx, atom);
    JS_FreeValue (ctx, url);
}

void setup_pm_request (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    // Free old request object if it exists to prevent memory leak
    JSValue old_request = JS_GetPropertyStr (ctx, pm, "request");
    if (!JS_IsUndefined (old_request)) {
        JS_FreeValue (ctx, old_request);
    }

    JSValue request = JS_NewObject (ctx);

    if (data && data->request) {
        // pm.request.url - Postman's Url object, not the string it used to be.
        install_request_url (ctx, request, data->request->url);

        // pm.request.method
        JS_SetPropertyStr (ctx, request, "method",
        JS_NewString (ctx, to_string (data->request->method)));

        // pm.request.headers - the object the write-back reads, so its methods
        // and plain assignment reach the same property set. Which set that is
        // depends on the hook - see script_request_header_view.
        JSValue headers = JS_NewObject (ctx);
        install_header_methods (ctx, headers, /*mutators=*/true);
        for (const auto& [key, value] : script_request_header_view (*data)) {
            define_header_entry (ctx, headers, key, value);
        }
        JS_SetPropertyStr (ctx, request, "headers", headers);

        // pm.request.body - a string for every mode, including the two that
        // carry their content in `fields`. A bodyless request still defines no
        // property at all, so `typeof pm.request.body` stays the way a script
        // tells "no body" from "a body that happens to be empty".
        if (data->request->body.mode != BodyMode::None) {
            const std::string view = script_body_view (data->request->body);
            JS_SetPropertyStr (ctx, request, "body", JS_NewString (ctx, view.c_str ()));
        }
    }

    JS_SetPropertyStr (ctx, pm, "request", request);
}

/**
 * `pm.info` - what request this script is attached to, and which hook it is.
 *
 * Rebuilt per execution alongside pm.request / pm.response, because contexts
 * are pooled: an object left over from the previous script would report the
 * previous request's name. A field with no value is left off the object
 * entirely, so a script reads `undefined` rather than an empty string that
 * looks like an answer.
 *
 * `iteration` / `iterationCount` are present only for a scenario run's steps -
 * the runner is the one caller that sets them, and every other caller leaves
 * them unset so the script reads `undefined` (see ScriptContext).
 */
void setup_pm_info (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    // Free the previous execution's object before replacing it, as the
    // request/response setups above do.
    JSValue old_info = JS_GetPropertyStr (ctx, pm, "info");
    if (!JS_IsUndefined (old_info)) {
        JS_FreeValue (ctx, old_info);
    }

    JSValue info = JS_NewObject (ctx);

    if (data) {
        if (data->request_id && !data->request_id->empty ()) {
            JS_SetPropertyStr (ctx, info, "requestId",
            JS_NewString (ctx, data->request_id->c_str ()));
        }
        if (data->request_name && !data->request_name->empty ()) {
            JS_SetPropertyStr (ctx, info, "requestName",
            JS_NewString (ctx, data->request_name->c_str ()));
        }
        if (data->event) {
            JS_SetPropertyStr (ctx, info, "eventName",
            JS_NewString (ctx, *data->event == ScriptEvent::PreRequest ? "prerequest" : "test"));
        }
        if (data->iteration) {
            JS_SetPropertyStr (ctx, info, "iteration",
            JS_NewInt64 (ctx, static_cast<int64_t> (*data->iteration)));
        }
        if (data->iteration_count) {
            JS_SetPropertyStr (ctx, info, "iterationCount",
            JS_NewInt64 (ctx, static_cast<int64_t> (*data->iteration_count)));
        }
    }

    JS_SetPropertyStr (ctx, pm, "info", info);
}

// ============================================================================
// pm.request write-back (pre-request scripts)
// ============================================================================

// Read a header object into `out`, naming it @p label in every message it can
// reject with. Two callers - the pm.request write-back and pm.sendRequest's
// object header form - because the rules below (empty name, non-primitive
// value, a case-insensitive clash) are properties of HTTP headers rather than
// of either surface. @p suggest_delete adds the removal hint that only means
// something for a live pm.request.headers object.
// @return why the headers were rejected, or nullopt when `out` is filled.
std::optional<std::string> read_header_object (JSContext* ctx,
JSValueConst js_headers,
const char* label,
bool suggest_delete,
Headers& out) {
    if (!JS_IsObject (js_headers) || JS_IsArray (js_headers) ||
    JS_IsFunction (ctx, js_headers)) {
        return std::string (label) + " must be an object, got " +
        std::string (js_type_name (ctx, js_headers));
    }

    JSPropertyEnum* props = nullptr;
    uint32_t count        = 0;
    if (JS_GetOwnPropertyNames (ctx, &props, &count, js_headers,
        JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
        return std::string (label) + " could not be enumerated";
    }

    std::optional<std::string> error;
    for (uint32_t i = 0; i < count && !error; i++) {
        const char* raw_key = JS_AtomToCString (ctx, props[i].atom);
        std::string key     = raw_key ? raw_key : "";
        if (raw_key) {
            JS_FreeCString (ctx, raw_key);
        }

        ScopedValue value (ctx, JS_GetProperty (ctx, js_headers, props[i].atom));
        // A header field-name cannot be empty, and a value that is not a
        // primitive has no honest wire form. Both are refused by name rather
        // than dropped, because a silently missing header is the very defect
        // this write-back exists to fix.
        if (key.empty ()) {
            error = std::string (label) + " has an empty header name";
        } else if (JS_IsString (value.get ()) || JS_IsNumber (value.get ()) ||
        JS_IsBool (value.get ())) {
            // JS object keys are case-sensitive; HTTP header names are not. So
            // `Authorization` and `authorization` are two properties over there
            // and one header over here, and whichever enumerated last would
            // silently win. Which one the script meant is unknowable, and one
            // of them is an Authorization header - refuse instead of guessing.
            if (auto clash = out.find (key); clash != out.end () && clash->first != key) {
                error = std::string (label) + " has both '" + clash->first +
                "' and '" + key +
                "' - HTTP header names are case-insensitive, so these are one "
                "header. "
                "Keep one.";
            } else {
                out[key] = js_to_string (ctx, value.get ());
            }
        } else {
            error = std::string (label) + "['" + key + "'] must be a string, got " +
            std::string (js_type_name (ctx, value.get ()));
            if (suggest_delete) {
                error = *error + " (use delete " + label + "['" + key + "'] to remove it)";
            }
        }
    }

    for (uint32_t i = 0; i < count; i++) {
        JS_FreeAtom (ctx, props[i].atom);
    }
    js_free (ctx, props);

    return error;
}

/**
 * @brief Apply the script's `pm.request` back onto the request that will be sent.
 *
 * The JS object is authoritative, not a diff: the header set it holds when the
 * script returns is the header set that goes on the wire, so
 * `delete pm.request.headers['Authorization']` removes an engine-applied
 * header, and dropping `pm.request.body` drops the body. That is the only rule
 * that stays true for a script which replaces `pm.request` wholesale.
 *
 * Precedence over engine-applied auth falls out of the ordering rather than
 * being a special case: `build_request` resolves auth into the request before
 * the script runs, so the script sees the real outgoing set and its writes are
 * simply later.
 *
 * All-or-nothing. Every field is staged and validated before anything is
 * committed, so a script that sets a good header and a bad method sends
 * neither instead of half of what it asked for.
 *
 * @return why the write-back was rejected, or nullopt when it was applied.
 */
std::optional<std::string> apply_pm_request_writeback (JSContext* ctx, Request& request) {
    ScopedValue global (ctx, JS_GetGlobalObject (ctx));
    ScopedValue pm (ctx, JS_GetPropertyStr (ctx, global.get (), "pm"));
    if (!JS_IsObject (pm.get ())) {
        // No `pm` at all - nothing was ever exposed for the script to write to.
        return std::nullopt;
    }

    ScopedValue js_request (ctx, JS_GetPropertyStr (ctx, pm.get (), "request"));
    if (!JS_IsObject (js_request.get ()) || JS_IsFunction (ctx, js_request.get ())) {
        return "pm.request must be an object, got " +
        std::string (js_type_name (ctx, js_request.get ()));
    }

    Request staged = request;

    // Either shape: the Url object `pm.request.url` normally holds, or a plain
    // string, which is what a script that replaced `pm.request` wholesale with
    // an object literal leaves there. Both are the URL; neither is a diff.
    ScopedValue js_url (ctx, JS_GetPropertyStr (ctx, js_request.get (), "url"));
    std::string url_error;
    auto url_text = script_url_text (ctx, js_url.get (), &url_error);
    if (!url_text) {
        return url_error.empty () ?
        "pm.request.url must be a string or a URL object, got " +
        std::string (js_type_name (ctx, js_url.get ())) :
        url_error;
    }
    staged.url = std::move (*url_text);
    if (staged.url.empty ()) {
        return std::string ("pm.request.url must not be empty");
    }

    ScopedValue js_method (ctx, JS_GetPropertyStr (ctx, js_request.get (), "method"));
    if (!JS_IsString (js_method.get ())) {
        return "pm.request.method must be a string, got " +
        std::string (js_type_name (ctx, js_method.get ()));
    }
    std::string method_text = js_to_string (ctx, js_method.get ());
    // `pm.request.method = 'post'` means POST. Upper-casing is a normalisation
    // of a value the script clearly meant, not the silent acceptance of a
    // wrong one - an unrecognised verb below still fails loudly.
    std::transform (method_text.begin (), method_text.end (), method_text.begin (),
    [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
    if (auto parsed = parse_method (method_text)) {
        staged.method = *parsed;
    } else {
        return "pm.request.method must be one of GET, POST, PUT, DELETE, "
               "PATCH, HEAD, OPTIONS (got \"" +
        js_to_string (ctx, js_method.get ()) + "\")";
    }

    ScopedValue js_headers (ctx, JS_GetPropertyStr (ctx, js_request.get (), "headers"));
    staged.headers.clear ();
    if (auto reason = read_header_object (ctx, js_headers.get (), "pm.request.headers",
        /*suggest_delete=*/true, staged.headers)) {
        return reason;
    }

    ScopedValue js_body (ctx, JS_GetPropertyStr (ctx, js_request.get (), "body"));
    if (JS_IsUndefined (js_body.get ()) || JS_IsNull (js_body.get ())) {
        staged.body = Body{};
    } else if (JS_IsString (js_body.get ())) {
        std::string body_text = js_to_string (ctx, js_body.get ());
        // Every other member of pm.request is authoritative rather than a diff:
        // whatever the object holds is what is sent. `body` cannot be read that
        // way for a form mode, because the string the script was handed is a
        // *view* of the fields - applying it back unconditionally would rewrite
        // the field list of every request whose script merely read the body
        // (dropping the disabled rows the view leaves out), and would refuse
        // every form-data request outright. So an unchanged string means
        // untouched, and the body is left exactly as it stands.
        const bool untouched = staged.body.mode != BodyMode::None &&
        body_text == script_body_view (staged.body);
        if (untouched) {
            // Nothing to apply. The wire outcome is identical either way for a
            // content mode; for a form mode this is what keeps a read-only
            // script from rewriting the body it only looked at.
        } else if (staged.body.mode == BodyMode::FormData) {
            // The only mode whose string view is not what goes on the wire, so
            // it is the only one that cannot take a string back. Parsing one
            // into text parts would also be the wrong shape the moment a part
            // can be a file (issue #393): a script appending a field would
            // silently drop the upload. Refused rather than applied to a body
            // the transfer layer would then ignore.
            return std::string (
            "pm.request.body cannot be assigned on a form-data request: its "
            "parts are multipart, not a string - edit the request's form "
            "fields, or delete pm.request.body to send no body");
        } else if (staged.body.mode == BodyMode::Form) {
            // The string view is the wire body here, so it parses straight back
            // into the fields the transfer layer reads. `content` is cleared to
            // hold the type's invariant: exactly one of the two carries a body.
            staged.body.fields = vayu::http::parse_urlencoded (body_text);
            staged.body.content.clear ();
        } else {
            staged.body.content = std::move (body_text);
            if (staged.body.mode == BodyMode::None) {
                // A body on a request that had none: Text is the mode that means
                // "this string, as written". Nothing downstream derives
                // Content-Type from the mode, so the script still owns that header.
                staged.body.mode = BodyMode::Text;
            }
        }
    } else {
        return "pm.request.body must be a string, got " +
        std::string (js_type_name (ctx, js_body.get ()));
    }

    request = std::move (staged);
    return std::nullopt;
}

// ============================================================================
// Variable scopes: pm.environment / pm.globals / pm.collectionVariables
// ============================================================================

// Which of the run's three variable maps a binding reads and writes. The value
// is the `magic` argument QuickJS hands back, so one implementation serves all
// three scopes. They were three hand-written copies of get/set; six methods
// each would have tripled that, and a copy is exactly what stops a fix landing
// everywhere it belongs.
enum VariableScope : int {
    SCOPE_ENVIRONMENT,
    SCOPE_GLOBALS,
    SCOPE_COLLECTION_VARIABLES
};

struct VariableScopeBinding {
    const char* property; // the name this scope answers to on `pm`
    VariableScope scope;
};

constexpr VariableScopeBinding variable_scope_bindings[] = {
    { "environment", SCOPE_ENVIRONMENT },
    { "globals", SCOPE_GLOBALS },
    { "collectionVariables", SCOPE_COLLECTION_VARIABLES },
};

// Postman resolves an unqualified name local -> data -> environment ->
// collection -> global. Vayu has neither a local nor a data scope, so the chain
// starts at the environment - the same order `{{name}}` resolution already uses
// app-side (docs/app/variable-resolution.md), which is what keeps a script's
// reading of a name identical to the URL's.
constexpr VariableScope variables_precedence[] = { SCOPE_ENVIRONMENT,
    SCOPE_COLLECTION_VARIABLES, SCOPE_GLOBALS };

// The map behind a scope, or nullptr when the run carries no such scope (a
// design run with no active environment, say). Every binding below reads that
// as an empty scope rather than an error: a script cannot see which scopes a
// run was given, so throwing would fail it for a reason its author has no way
// to inspect.
Environment* scope_variables (JSContext* ctx, int magic) {
    auto* data = get_context_data (ctx);
    if (!data) {
        return nullptr;
    }
    switch (magic) {
    case SCOPE_ENVIRONMENT: return data->environment;
    case SCOPE_GLOBALS: return data->globals;
    case SCOPE_COLLECTION_VARIABLES: return data->collectionVariables;
    default: return nullptr;
    }
}

// Every map a *read* of `magic` may see, weakest first. Only the collection
// scope has more than one: its ancestor collections stack underneath it, root
// weakest, so an inherited name resolves for a script the way `{{name}}`
// already resolves it in the URL (issue #234). A write never consults this -
// `scope_variables` alone is the write target, which is what keeps ancestors
// read-only and the copy-down hazard impossible.
//
// One order for the whole file: the lookups below reverse it to stop at the
// nearest definition and the snapshots fold along it so a nearer definition
// overwrites a farther one. Deriving both from one list is what stops `get`
// and `toObject` answering the same name two ways.
std::vector<const Environment*> scope_maps (JSContext* ctx, int magic) {
    std::vector<const Environment*> maps;
    auto* data = get_context_data (ctx);
    if (data && magic == SCOPE_COLLECTION_VARIABLES && data->collectionAncestors) {
        maps.reserve (data->collectionAncestors->size () + 1);
        for (const Environment& ancestor : *data->collectionAncestors) {
            maps.push_back (&ancestor);
        }
    }
    if (const Environment* own = scope_variables (ctx, magic)) {
        maps.push_back (own);
    }
    return maps;
}

// The definition of `key` a read of `magic` finds, or null when the walk ends
// without one. A disabled row is looked *past* rather than stopped at, so a
// leaf collection that unticks an inherited name falls through to the
// ancestor's value - the same rule that already makes a disabled variable
// invisible within a single scope.
const Variable* lookup_variable (JSContext* ctx, int magic, const std::string& key) {
    const auto maps = scope_maps (ctx, magic);
    for (auto it = maps.rbegin (); it != maps.rend (); ++it) {
        auto found = (*it)->find (key);
        if (found != (*it)->end () && found->second.enabled) {
            return &found->second;
        }
    }
    return nullptr;
}

// Hand every enabled variable a read of `magic` can see to `emit`, weakest
// scope first, so a caller merging them lands on the same value
// `lookup_variable` would have answered for that name.
template <typename Emit>
void merge_visible_variables (JSContext* ctx, int magic, Emit&& emit) {
    for (const Environment* map : scope_maps (ctx, magic)) {
        for (const auto& [key, variable] : *map) {
            if (variable.enabled) {
                emit (key, variable);
            }
        }
    }
}

// A disabled variable is a row the user unticked in the variables editor, so
// `get`, `has` and `toObject` all look straight past it - reading it would
// resurrect a value that was switched off. `unset` and `clear` still remove it:
// those are asked to delete a key, not to read one.
JSValue
js_pm_scope_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    if (const Variable* found =
        lookup_variable (ctx, magic, js_to_string (ctx, argv[0]))) {
        return cast_variable_to_jsvalue (ctx, *found);
    }

    return JS_UNDEFINED;
}

// Update a variable's value while preserving an existing key's secret, enabled
// and type fields; a brand-new key gets the current defaults. Shared by every
// scope's set() so a script that re-sets an existing (e.g. secret) variable
// does not silently strip its flag or reset its type.
//
// A brand-new key is also stamped with its creation time, the app's ordering
// key for the variables editor (issue #135). This is the one place the engine
// may invent a `created_at`, because it is the only place the engine creates a
// variable - stamping an existing one would sort it below rows the user added
// after it.
void set_variable_preserving (Environment& map, const std::string& key, std::string value) {
    auto it = map.find (key);
    if (it != map.end ()) {
        it->second.value = std::move (value); // preserve secret, enabled, type, created_at
    } else {
        Variable created{ std::move (value), false, true }; // new var: current defaults
        created.created_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                             .count ();
        map[key] = std::move (created);
    }
}

JSValue
js_pm_scope_set (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 2) {
        return JS_UNDEFINED;
    }

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_UNDEFINED;
    }

    std::string key   = js_to_string (ctx, argv[0]);
    std::string value = js_to_string (ctx, argv[1]);

    set_variable_preserving (*variables, key, std::move (value));

    return JS_UNDEFINED;
}

JSValue
js_pm_scope_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_NewBool (ctx, 0);
    }

    return JS_NewBool (ctx,
    lookup_variable (ctx, magic, js_to_string (ctx, argv[0])) != nullptr ? 1 : 0);
}

// The method with no workaround: setting a variable to "" leaves an enabled
// empty variable behind, which is not the same thing to `{{template}}`
// resolution as the variable being gone. The removal reaches disk through
// persist_script_variables, which rewrites a scope whenever the map it ends
// with differs from the one on disk.
//
// Like `set` and `clear`, this erases from the scope's own map only. On the
// collection scope that is the request's immediate parent: unsetting a name
// the leaf shadowed makes an ancestor's definition visible again rather than
// deleting it. Inheritance can be shadowed from below, never deleted from
// below (issue #234).
JSValue
js_pm_scope_unset (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_UNDEFINED;
    }

    variables->erase (js_to_string (ctx, argv[0]));

    return JS_UNDEFINED;
}

JSValue
js_pm_scope_clear (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;

    if (Environment* variables = scope_variables (ctx, magic)) {
        variables->clear ();
    }

    return JS_UNDEFINED;
}

JSValue
js_pm_scope_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue snapshot = JS_NewObject (ctx);
    if (JS_IsException (snapshot)) {
        return snapshot;
    }

    merge_visible_variables (ctx, magic, [&] (const std::string& key, const Variable& variable) {
        JS_SetPropertyStr (
        ctx, snapshot, key.c_str (), cast_variable_to_jsvalue (ctx, variable));
    });

    return snapshot;
}

void setup_pm_variable_scope (JSContext* ctx, JSValue pm, const VariableScopeBinding& binding) {
    JSValue scope   = JS_NewObject (ctx);
    const int magic = binding.scope;

    JS_SetPropertyStr (ctx, scope, "get",
    JS_NewCFunctionMagic (ctx, js_pm_scope_get, "get", 1, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "set",
    JS_NewCFunctionMagic (ctx, js_pm_scope_set, "set", 2, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "has",
    JS_NewCFunctionMagic (ctx, js_pm_scope_has, "has", 1, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "unset",
    JS_NewCFunctionMagic (ctx, js_pm_scope_unset, "unset", 1, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "clear",
    JS_NewCFunctionMagic (ctx, js_pm_scope_clear, "clear", 0, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "toObject",
    JS_NewCFunctionMagic (
    ctx, js_pm_scope_to_object, "toObject", 0, JS_CFUNC_generic_magic, magic));

    JS_SetPropertyStr (ctx, pm, binding.property, scope);
}

// ============================================================================
// pm.variables - the merged, read-only accessor
// ============================================================================

JSValue js_pm_variables_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    const std::string key = js_to_string (ctx, argv[0]);
    for (const VariableScope scope : variables_precedence) {
        if (const Variable* found = lookup_variable (ctx, scope, key)) {
            return cast_variable_to_jsvalue (ctx, *found);
        }
    }

    return JS_UNDEFINED;
}

JSValue js_pm_variables_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_NewBool (ctx, 0);
    }

    const std::string key = js_to_string (ctx, argv[0]);
    for (const VariableScope scope : variables_precedence) {
        if (lookup_variable (ctx, scope, key)) {
            return JS_NewBool (ctx, 1);
        }
    }

    return JS_NewBool (ctx, 0);
}

JSValue js_pm_variables_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue snapshot = JS_NewObject (ctx);
    if (JS_IsException (snapshot)) {
        return snapshot;
    }

    // Weakest scope first, so a stronger one overwrites it and the snapshot
    // agrees with what get() would have answered for every key in it.
    for (auto it = std::rbegin (variables_precedence);
    it != std::rend (variables_precedence); ++it) {
        merge_visible_variables (
        ctx, *it, [&] (const std::string& key, const Variable& variable) {
            JS_SetPropertyStr (ctx, snapshot, key.c_str (),
            cast_variable_to_jsvalue (ctx, variable));
        });
    }

    return snapshot;
}

// pm.variables.replaceIn - full `{{template}}` resolution of a string the
// script opts in, at call time.
//
// This is the sanctioned way to `{{...}}` inside a script. Script *text* is
// never interpolated (issue #226, D16: a rewrite cannot tell code from a
// string literal, and splicing variable values into source is an injection);
// replaceIn keeps values as data - the same single-pass resolver the engine's
// POST /compose uses (`resolve_template`), so the semantics are identical:
// scopes win over generators, a dynamic `{{$guid}}` generates per occurrence,
// an unknown `$name` keeps its braces, an ordinary unknown name becomes "".
//
// Two deliberate differences from compose-time resolution, both consequences
// of *when* this runs:
//  - The map is built at call time from the script's scopes, so a variable
//    set earlier in the same script resolves - unlike `{{}}` in the URL,
//    which was composed before the script started (D1).
//  - The collection scope is the script context's - the request's collection
//    chain, leaf shadowing ancestor (issue #234) - with pm.variables' own
//    precedence (environment > collection > globals). The raw stored string
//    substitutes, never the typed value - matching `{{}}`, not
//    pm.variables.get.
//
// Strict about its argument: a non-string is a TypeError rather than a
// coerced "undefined" - the caller almost certainly holds a bug.
/// The row's columns, in payload order, for the "columns: ..." half of the
/// refusal above. Mirrors `core/scenario_data.cpp`'s `describe_columns`, whose
/// wording a bind-time failure already uses - the same mistake should read the
/// same way whether it was the URL or a script that reached the column.
std::string describe_iteration_columns (const nlohmann::json& row) {
    std::string out;
    for (const auto& [key, value] : row.items ()) {
        (void)value;
        if (!out.empty ()) {
            out += ", ";
        }
        out += key;
    }
    return out.empty () ? "none" : out;
}

JSValue js_pm_variables_replace_in (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "pm.variables.replaceIn expects a string, e.g. "
        "pm.variables.replaceIn(\"{{$guid}}\")");
    }

    const std::string input = js_to_string (ctx, argv[0]);
    vayu::http::VariableValues values;
    // Weakest scope first so a stronger one overwrites - the same walk
    // toObject() does, and the same answer get() would give per name.
    for (auto it = std::rbegin (variables_precedence);
    it != std::rend (variables_precedence); ++it) {
        merge_visible_variables (
        ctx, *it, [&] (const std::string& key, const Variable& variable) {
            values[key] = variable.value;
        });
    }

    auto* data = get_context_data (ctx);
    if (data == nullptr || data->iteration_data == nullptr ||
    !data->iteration_data->is_object ()) {
        // No row to resolve against, so the namespace stays written as it
        // stands - what composition does, and what lets one script run in both
        // a data-driven run and a plain send.
        return JS_NewString (ctx, vayu::http::resolve_template (input, values).c_str ());
    }

    vayu::http::DataRowColumns row;
    for (const auto& [column, cell] : data->iteration_data->items ()) {
        row.columns[column] = vayu::http::render_data_value (cell);
    }

    std::optional<std::string> missing;
    const std::string resolved =
    vayu::http::resolve_template_with_data (input, values, row, missing);
    if (missing) {
        // The bind-time rule, in the shape a script can catch: naming the token
        // and the columns the row does carry, because the mistake is almost
        // always a spelling and the answer is in the second half.
        return JS_ThrowTypeError (ctx,
        "pm.variables.replaceIn: {{%s}} names a column this data row does not "
        "have (columns: %s)",
        missing->c_str (), describe_iteration_columns (*data->iteration_data).c_str ());
    }
    return JS_NewString (ctx, resolved.c_str ());
}

// Postman's pm.variables.set writes to the *local* scope: alive for one
// request, never stored. Vayu has no such scope, and neither substitute is
// honest - writing to the environment persists a value the author expects to
// vanish, and dropping the call loses a write they believe happened. So it
// throws, naming the three scopes that do exist. Documented in
// docs/engine/scripting.md; changing this changes a documented contract.
JSValue js_pm_variables_set (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError (ctx,
    "pm.variables.set is not supported: Vayu has no local variable scope. "
    "Use pm.environment.set(), pm.collectionVariables.set() or "
    "pm.globals.set() "
    "to choose where the value is stored.");
}

void setup_pm_variables (JSContext* ctx, JSValue pm) {
    JSValue variables = JS_NewObject (ctx);

    JS_SetPropertyStr (
    ctx, variables, "get", JS_NewCFunction (ctx, js_pm_variables_get, "get", 1));
    JS_SetPropertyStr (
    ctx, variables, "has", JS_NewCFunction (ctx, js_pm_variables_has, "has", 1));
    JS_SetPropertyStr (ctx, variables, "toObject",
    JS_NewCFunction (ctx, js_pm_variables_to_object, "toObject", 0));
    JS_SetPropertyStr (ctx, variables, "replaceIn",
    JS_NewCFunction (ctx, js_pm_variables_replace_in, "replaceIn", 1));
    JS_SetPropertyStr (
    ctx, variables, "set", JS_NewCFunction (ctx, js_pm_variables_set, "set", 2));

    JS_SetPropertyStr (ctx, pm, "variables", variables);
}

// ============================================================================
// pm.sendRequest
// ============================================================================

// One entry of Postman's array header form: { key, value }.
std::optional<std::string>
read_header_pair (JSContext* ctx, JSValueConst entry, Headers& out) {
    if (!JS_IsObject (entry) || JS_IsArray (entry) || JS_IsFunction (ctx, entry)) {
        return "pm.sendRequest header entries must be { key, value } objects, "
               "got " +
        std::string (js_type_name (ctx, entry));
    }
    ScopedValue key (ctx, JS_GetPropertyStr (ctx, entry, "key"));
    ScopedValue value (ctx, JS_GetPropertyStr (ctx, entry, "value"));
    if (!JS_IsString (key.get ())) {
        return "pm.sendRequest header entries need a string 'key', got " +
        std::string (js_type_name (ctx, key.get ()));
    }
    if (!JS_IsString (value.get ()) && !JS_IsNumber (value.get ()) &&
    !JS_IsBool (value.get ())) {
        return "pm.sendRequest header '" + js_to_string (ctx, key.get ()) +
        "' needs a string value, got " + std::string (js_type_name (ctx, value.get ()));
    }
    std::string name = js_to_string (ctx, key.get ());
    if (name.empty ()) {
        return std::string ("pm.sendRequest has a header with an empty name");
    }
    out[name] = js_to_string (ctx, value.get ());
    return std::nullopt;
}

// pm.sendRequest's headers, in either shape Postman accepts: an array of
// { key, value } or a plain object. Both, because the array is what a Postman
// script carries over and the object is what `pm.request.headers` reads as in
// this same sandbox - a user copying from one to the other should not have a
// header silently vanish.
std::optional<std::string>
read_send_request_headers (JSContext* ctx, JSValueConst value, Headers& out) {
    if (JS_IsArray (value)) {
        int64_t length = 0;
        if (JS_GetLength (ctx, value, &length) < 0) {
            return std::string (
            "pm.sendRequest headers could not be enumerated");
        }
        for (int64_t i = 0; i < length; i++) {
            ScopedValue entry (ctx, JS_GetPropertyInt64 (ctx, value, i));
            if (auto reason = read_header_pair (ctx, entry.get (), out)) {
                return reason;
            }
        }
        return std::nullopt;
    }
    return read_header_object (
    ctx, value, "pm.sendRequest headers", /*suggest_delete=*/false, out);
}

// pm.sendRequest's body: a raw string, or Postman's { mode: 'raw', raw }.
//
// No Content-Type is inferred from the mode - the engine's send path derives
// none either, so the header the script sets is the header that goes out. An
// inferred one would silently disagree with an explicit one.
std::optional<std::string>
read_send_request_body (JSContext* ctx, JSValueConst value, Body& out) {
    if (JS_IsUndefined (value) || JS_IsNull (value)) {
        return std::nullopt;
    }
    if (JS_IsString (value)) {
        out.mode    = BodyMode::Text;
        out.content = js_to_string (ctx, value);
        return std::nullopt;
    }
    if (!JS_IsObject (value) || JS_IsArray (value) || JS_IsFunction (ctx, value)) {
        return "pm.sendRequest options.body must be a string or "
               "{ mode: 'raw', raw: '...' }, got " +
        std::string (js_type_name (ctx, value));
    }

    ScopedValue mode (ctx, JS_GetPropertyStr (ctx, value, "mode"));
    const std::string mode_text =
    JS_IsString (mode.get ()) ? js_to_string (ctx, mode.get ()) : "";
    // Postman's formdata / urlencoded / file modes are refused by name rather
    // than sent as an empty body: a request that goes out without the payload
    // the script wrote is worse than one that does not go out.
    if (mode_text != "raw") {
        return "pm.sendRequest supports only options.body.mode 'raw' (got " +
        (mode_text.empty () ? std::string ("none") : "\"" + mode_text + "\"") +
        "). Serialise the body yourself and set the Content-Type header.";
    }

    ScopedValue raw (ctx, JS_GetPropertyStr (ctx, value, "raw"));
    if (!JS_IsString (raw.get ())) {
        return "pm.sendRequest options.body.raw must be a string, got " +
        std::string (js_type_name (ctx, raw.get ()));
    }
    out.mode    = BodyMode::Text;
    out.content = js_to_string (ctx, raw.get ());
    return std::nullopt;
}

// Translate pm.sendRequest's first argument into a Request.
// @return why it was rejected, or nullopt when `out` is filled.
std::optional<std::string>
build_send_request (JSContext* ctx, JSValueConst arg, Request& out) {
    // A Url object here is `pm.sendRequest(pm.request.url, cb)`, which #991
    // made the natural spelling of "send this request again" - it has to be
    // read before the options-object branch, or the Url object falls into it
    // and is refused for having no `url` member.
    if (auto direct = script_url_text (ctx, arg)) {
        out.url = std::move (*direct);
        if (out.url.empty ()) {
            return std::string ("pm.sendRequest was given an empty URL");
        }
        return std::nullopt;
    }

    if (!JS_IsObject (arg) || JS_IsArray (arg) || JS_IsFunction (ctx, arg)) {
        return "pm.sendRequest expects a URL string or an options object, "
               "got " +
        std::string (js_type_name (ctx, arg));
    }

    ScopedValue js_url (ctx, JS_GetPropertyStr (ctx, arg, "url"));
    auto options_url = script_url_text (ctx, js_url.get ());
    if (!options_url) {
        // Postman's *literal* URL-object form - a `{host: [...], path: [...]}`
        // built by hand - is still not accepted; pm.request.url is.
        return "pm.sendRequest options.url must be a string or pm.request.url, "
               "got " +
        std::string (js_type_name (ctx, js_url.get ()));
    }
    out.url = std::move (*options_url);
    if (out.url.empty ()) {
        return std::string ("pm.sendRequest options.url is empty");
    }

    ScopedValue js_method (ctx, JS_GetPropertyStr (ctx, arg, "method"));
    if (!JS_IsUndefined (js_method.get ()) && !JS_IsNull (js_method.get ())) {
        if (!JS_IsString (js_method.get ())) {
            return "pm.sendRequest options.method must be a string, got " +
            std::string (js_type_name (ctx, js_method.get ()));
        }
        std::string method_text = js_to_string (ctx, js_method.get ());
        // Same normalisation pm.request's write-back applies: 'post' clearly
        // means POST, while an unrecognised verb below still fails loudly.
        std::transform (method_text.begin (), method_text.end (), method_text.begin (),
        [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
        if (auto parsed = parse_method (method_text)) {
            out.method = *parsed;
        } else {
            return "pm.sendRequest options.method must be one of GET, POST, "
                   "PUT, "
                   "DELETE, PATCH, HEAD, OPTIONS (got \"" +
            js_to_string (ctx, js_method.get ()) + "\")";
        }
    }

    // `header` is Postman's spelling, `headers` is the one pm.request uses.
    // Both are read, neither is preferred: given both there is no way to know
    // which the script meant, and dropping either would send a request missing
    // headers the script wrote.
    ScopedValue js_header (ctx, JS_GetPropertyStr (ctx, arg, "header"));
    ScopedValue js_headers (ctx, JS_GetPropertyStr (ctx, arg, "headers"));
    const auto present = [] (JSValueConst v) {
        return !JS_IsUndefined (v) && !JS_IsNull (v);
    };
    if (present (js_header.get ()) && present (js_headers.get ())) {
        return std::string (
        "pm.sendRequest was given both options.header and "
        "options.headers - they are one slot under two names. Keep one.");
    }
    if (present (js_header.get ()) || present (js_headers.get ())) {
        JSValueConst chosen =
        present (js_header.get ()) ? js_header.get () : js_headers.get ();
        if (auto reason = read_send_request_headers (ctx, chosen, out.headers)) {
            return reason;
        }
    }

    ScopedValue js_body (ctx, JS_GetPropertyStr (ctx, arg, "body"));
    if (auto reason = read_send_request_body (ctx, js_body.get (), out.body)) {
        return reason;
    }

    ScopedValue js_timeout (ctx, JS_GetPropertyStr (ctx, arg, "timeout"));
    if (present (js_timeout.get ())) {
        if (!JS_IsNumber (js_timeout.get ())) {
            return "pm.sendRequest options.timeout must be a number of "
                   "milliseconds, got " +
            std::string (js_type_name (ctx, js_timeout.get ()));
        }
        double ms = 0.0;
        JS_ToFloat64 (ctx, &ms, js_timeout.get ());
        if (!std::isfinite (ms) || ms <= 0.0) {
            return "pm.sendRequest options.timeout must be a positive number "
                   "of "
                   "milliseconds (got " +
            js_to_string (ctx, js_timeout.get ()) + ")";
        }
        out.timeout_ms = static_cast<int> (
        std::min (ms, static_cast<double> (std::numeric_limits<int>::max ())));
    }

    return std::nullopt;
}

// The response a pm.sendRequest callback receives.
//
// A deliberate subset of pm.response: code, status, responseTime, headers,
// json() and text(). `status` is the numeric code, as it is on pm.response -
// Postman spells the reason phrase there instead, but two objects called a
// response inside one sandbox disagreeing about what `status` means is the
// worse divergence. The body readers are the same two functions pm.response
// installs, so the two cannot drift.
JSValue build_send_response (JSContext* ctx, const Response& response) {
    JSValue result = JS_NewObject (ctx);

    JS_SetPropertyStr (ctx, result, "code", JS_NewInt32 (ctx, response.status_code));
    JS_SetPropertyStr (ctx, result, "status", JS_NewInt32 (ctx, response.status_code));
    JS_SetPropertyStr (
    ctx, result, "responseTime", JS_NewFloat64 (ctx, response.timing.total_ms));

    JSValue headers = JS_NewObject (ctx);
    install_header_methods (ctx, headers, /*mutators=*/false);
    for (const auto& [key, value] : response.headers) {
        define_header_entry (ctx, headers, key, value);
    }
    JS_SetPropertyStr (ctx, result, "headers", headers);

    install_response_body_readers (ctx, result, response.body);

    return result;
}

// The error a pm.sendRequest callback receives: a real Error, carrying the
// engine's own error code so a script can tell a timeout from a refusal
// without matching on message text.
JSValue build_send_error (JSContext* ctx, ErrorCode code, const std::string& message) {
    JSValue error = JS_NewError (ctx);
    JS_SetPropertyStr (ctx, error, "message", JS_NewString (ctx, message.c_str ()));
    JS_SetPropertyStr (ctx, error, "code", JS_NewString (ctx, vayu::to_string (code)));
    return error;
}

/**
 * pm.sendRequest(urlOrOptions, callback)
 *
 * Synchronous by construction, and callback-shaped rather than promise-shaped.
 * The sandbox has a Promise but nothing drains its job queue - no event loop,
 * no setTimeout - so an awaited value never resumes and the script reports a
 * timeout instead of a result. Postman's own signature is callback-based, and
 * a callback can be honoured honestly: block on the send, then invoke
 * callback(err, res) inline. The promise-returning overload Postman also
 * offers is deliberately absent; it could only never resolve.
 *
 * Three things are refused by throwing rather than by calling the callback,
 * because they are the script's mistakes and not the network's: the feature
 * being off, the per-script request cap, and an unusable argument. Transport
 * failures - refused, DNS, timeout - are the network's answer and reach the
 * callback as an error, which is where a Postman script looks for them.
 */
JSValue js_pm_send_request (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;

    auto* data = get_context_data (ctx);
    if (!data) {
        return JS_ThrowInternalError (ctx, "No script context available");
    }

    if (!data->allow_send_request) {
        return JS_ThrowPlainError (ctx,
        "pm.sendRequest is not available here. Vayu's MCP target allowlist is "
        "checked by the MCP server before it calls the engine, so a request "
        "issued from inside a script would bypass a control you configured in "
        "Settings; script-issued requests are refused unless the caller asks "
        "for them, and the MCP server never does. See docs/engine/mcp.md.");
    }

    if (argc < 2) {
        return JS_ThrowTypeError (
        ctx, "pm.sendRequest requires a URL (or options object) and a callback");
    }
    if (!JS_IsFunction (ctx, argv[1])) {
        return JS_ThrowTypeError (ctx,
        "pm.sendRequest requires a callback function as its second argument - "
        "it has no promise form, because this sandbox never resolves one");
    }

    constexpr int limit = vayu::core::constants::script_engine::SEND_REQUEST_LIMIT;
    if (data->send_request_count >= limit) {
        return JS_ThrowPlainError (ctx,
        "pm.sendRequest may issue at most %d requests per script; this is "
        "request %d",
        limit, data->send_request_count + 1);
    }

    Request request;
    if (auto reason = build_send_request (ctx, argv[0], request)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }

    // The script's wall-clock budget is enforced by a QuickJS interrupt handler
    // that only runs *between bytecode operations*, so a blocking C function
    // never yields to it: without this clamp a 5s script could hold its thread
    // for the request's 30s timeout, six times the budget the user set, with
    // no error and no way to interrupt it.
    if (auto remaining = remaining_script_budget_ms (ctx)) {
        if (*remaining <= 0) {
            return JS_ThrowPlainError (ctx,
            "pm.sendRequest was called with none of the script's time budget "
            "left");
        }
        request.timeout_ms = static_cast<int> (
        std::min (static_cast<int64_t> (request.timeout_ms), *remaining));
    }

    // Counted before the send, so a request that fails still spends budget -
    // otherwise a loop against a refusing host would never reach the cap.
    data->send_request_count++;

    // Shares the enclosing execute's jar - see ScriptContext::cookie_jar for
    // why sharing rather than isolating is the right default. Null jar (a load
    // run) leaves the client cookie-less, which is what it was before #301.
    vayu::http::ClientConfig client_config;
    client_config.cookie_jar   = data->cookie_jar;
    client_config.cookie_scope = data->cookie_scope;
    // The same route out of the machine the enclosing exchange's own send
    // takes (issue #705). A script that authenticates through sendRequest and
    // then lets the real request carry the session needs both to reach the
    // network the same way.
    client_config.transport = data->transport;
    // Staged jar writes ride the next transfer of this execution, and this is
    // it - so a script that sets a cookie and then sends through
    // pm.sendRequest carries it. Drained rather than copied: this transfer's
    // capture persists them, and applying them a second time afterwards would
    // undo whatever its response changed.
    if (data->cookie_writes) {
        client_config.cookie_writes = std::move (*data->cookie_writes);
        data->cookie_writes->clear ();
    }
    vayu::http::Client client (client_config);
    auto sent = client.send (request);

    JSValue err = JS_NULL;
    JSValue res = JS_NULL;
    if (sent.is_error ()) {
        err = build_send_error (ctx, sent.error ().code, sent.error ().message);
    } else if (const Response& response = sent.value (); response.has_error ()) {
        err = build_send_error (ctx, response.error_code, response.error_message);
    } else {
        res = build_send_response (ctx, sent.value ());
    }

    JSValue args[2] = { err, res };
    JSValue ret     = JS_Call (ctx, argv[1], JS_UNDEFINED, 2, args);
    JS_FreeValue (ctx, err);
    JS_FreeValue (ctx, res);

    // A callback that threw - a failed pm.expect inside it, most likely - must
    // surface as the script's error rather than be swallowed here.
    if (JS_IsException (ret)) {
        return JS_EXCEPTION;
    }
    JS_FreeValue (ctx, ret);

    return JS_UNDEFINED;
}

// ============================================================================
// pm.cookies - the jar, matched against the current request's URL
// ============================================================================

// The context behind a pm.cookies member, or nullptr having thrown the
// sentence that says why there is no jar here (a load run, a hand-built
// context - see ScriptContext::cookie_jar). @p member is the full spelling, so
// the message names what the script actually wrote.
ContextData* jar_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data) {
        JS_ThrowInternalError (ctx, "No script context available");
        return nullptr;
    }
    if (!data->cookie_jar) {
        JS_ThrowPlainError (ctx,
        "pm.cookies.%s is not available here: the cookie jar is a design-mode "
        "feature, and a load run's scripts have no jar to read. Use "
        "pm.response.cookies for the Set-Cookie of the response in hand. See "
        "docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data;
}

// The scope's lines with this script's own staged writes applied on top. Every
// read goes through this, so a `jar().set` followed by a read answers with what
// was just written rather than with the map the write has not reached yet.
std::vector<std::string> staged_jar_lines (const ContextData& data) {
    auto lines = data.cookie_jar->lines_for (data.cookie_scope);
    if (!data.cookie_writes) {
        return lines;
    }
    return vayu::http::apply_cookie_writes (std::move (lines), *data.cookie_writes);
}

// The jar's cookies that would be sent to the request this script belongs to.
// Returns nullopt having thrown: either there is no jar, or there is no request
// to match against, and both deserve a sentence rather than an empty answer.
std::optional<std::vector<vayu::http::JarCookie>>
jar_cookies_from_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data || !data->request) {
        JS_ThrowInternalError (ctx, "No request available");
        return std::nullopt;
    }
    if (!jar_context (ctx, member)) {
        return std::nullopt;
    }
    return vayu::http::matching_in (staged_jar_lines (*data), data->request->url);
}

// Which cookie answers for a name when the jar holds it more than once - the
// same name on `/` and on `/admin`, say. RFC 6265 §5.4 orders the request's
// Cookie header by descending path length, so the longest matching path is the
// one a server reads as *the* value, and it is the one to report. The jar's
// own order cannot decide this: it is libcurl's internal order, not wire order.
const vayu::http::JarCookie*
find_jar_cookie (const std::vector<vayu::http::JarCookie>& cookies, const std::string& name) {
    const vayu::http::JarCookie* best = nullptr;
    for (const auto& cookie : cookies) {
        if (cookie.name != name) {
            continue;
        }
        if (!best || cookie.path.size () >= best->path.size ()) {
            best = &cookie;
        }
    }
    return best;
}

JSValue js_jar_cookies_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto name = read_cookie_name_arg (ctx, "get", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto cookies = jar_cookies_from_context (ctx, "get");
    if (!cookies) {
        return JS_EXCEPTION;
    }
    const auto* cookie = find_jar_cookie (*cookies, *name);
    // undefined for an absent cookie, exactly as pm.response.cookies.get does.
    return cookie ? JS_NewString (ctx, cookie->value.c_str ()) : JS_UNDEFINED;
}

JSValue js_jar_cookies_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto name = read_cookie_name_arg (ctx, "has", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto cookies = jar_cookies_from_context (ctx, "has");
    if (!cookies) {
        return JS_EXCEPTION;
    }
    return JS_NewBool (ctx, find_jar_cookie (*cookies, *name) != nullptr);
}

JSValue js_jar_cookies_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto cookies = jar_cookies_from_context (ctx, "toObject");
    if (!cookies) {
        return JS_EXCEPTION;
    }
    JSValue obj = JS_NewObject (ctx);
    // Through find_jar_cookie rather than by assigning as we go, so a name the
    // jar holds twice reads the same here as through get().
    for (const auto& cookie : *cookies) {
        const auto* chosen = find_jar_cookie (*cookies, cookie.name);
        JS_SetPropertyStr (ctx, obj, cookie.name.c_str (),
        JS_NewString (ctx, chosen->value.c_str ()));
    }
    return obj;
}

// ----------------------------------------------------------------------------
// pm.cookies.jar() - the write half (issue #337)
// ----------------------------------------------------------------------------

// Where a jar write is staged, or nullptr having thrown. A jar with nowhere to
// apply writes is refused rather than silently accepted: a call that reported
// success for a cookie that went nowhere is the failure this whole surface
// exists to avoid.
std::vector<vayu::http::CookieWrite>* jar_writes (JSContext* ctx, const char* member) {
    auto* data = jar_context (ctx, member);
    if (!data) {
        return nullptr;
    }
    if (!data->cookie_writes) {
        JS_ThrowPlainError (ctx,
        "pm.cookies.%s is not available here: this execution has nowhere to "
        "apply a jar write, so accepting one would report success for a cookie "
        "that goes nowhere. See docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data->cookie_writes;
}

// One required string argument of a jar() method. Every one of them is
// URL-scoped, which is the whole reason Postman's write half hangs off `jar()`
// rather than off `pm.cookies` - so the URL is never optional.
//
// @p url_arg marks the positions that take a URL, which since #991 also accept
// the Url object `pm.request.url` holds - `jar().set(pm.request.url, ...)` is
// the documented example in both script docs and was a string argument until
// that object replaced the string. A cookie *name* stays string-only: nothing
// makes a URL a plausible name, so accepting one there would only let a
// misplaced argument through.
std::optional<std::string> read_jar_string_arg (JSContext* ctx,
const char* member,
const char* label,
int index,
int argc,
JSValueConst* argv,
bool url_arg = false) {
    std::optional<std::string> text;
    if (index < argc) {
        text = url_arg ? script_url_text (ctx, argv[index]) :
                         (JS_IsString (argv[index]) ?
                         std::optional<std::string> (js_to_string (ctx, argv[index])) :
                         std::nullopt);
    }
    if (!text) {
        JS_ThrowTypeError (ctx, "pm.cookies.jar().%s needs a %s string, got %s", member,
        label, index >= argc ? "no argument" : js_type_name (ctx, argv[index]));
        return std::nullopt;
    }
    if (text->empty ()) {
        JS_ThrowTypeError (ctx, "pm.cookies.jar().%s needs a non-empty %s", member, label);
        return std::nullopt;
    }
    return text;
}

// `set`'s cookie object: `{ name, value, domain?, path?, secure?, httpOnly?,
// expires? }`. Returns the reason it was refused rather than a half-filled
// cookie - a field misread here becomes a cookie stored under the wrong
// domain, which reads as "the session did not stick" three requests later.
std::optional<std::string>
read_jar_cookie_arg (JSContext* ctx, JSValueConst arg, vayu::http::JarCookie& out) {
    if (!JS_IsObject (arg) || JS_IsArray (arg) || JS_IsFunction (ctx, arg)) {
        return "pm.cookies.jar().set expects (url, {name, value, ...}) or "
               "(url, name, value), got " +
        std::string (js_type_name (ctx, arg)) + " as its second argument";
    }

    const auto required_string = [&] (const char* key,
                                 std::string& target) -> std::optional<std::string> {
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, arg, key));
        if (!JS_IsString (value.get ())) {
            return "pm.cookies.jar().set cookie." + std::string (key) +
            " must be a string, got " + std::string (js_type_name (ctx, value.get ()));
        }
        target = js_to_string (ctx, value.get ());
        return std::nullopt;
    };
    if (auto reason = required_string ("name", out.name)) {
        return reason;
    }
    if (auto reason = required_string ("value", out.value)) {
        return reason;
    }

    const auto optional_string = [&] (const char* key,
                                 std::string& target) -> std::optional<std::string> {
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, arg, key));
        if (JS_IsUndefined (value.get ()) || JS_IsNull (value.get ())) {
            return std::nullopt;
        }
        if (!JS_IsString (value.get ())) {
            return "pm.cookies.jar().set cookie." + std::string (key) +
            " must be a string, got " + std::string (js_type_name (ctx, value.get ()));
        }
        target = js_to_string (ctx, value.get ());
        return std::nullopt;
    };
    if (auto reason = optional_string ("domain", out.domain)) {
        return reason;
    }
    if (auto reason = optional_string ("path", out.path)) {
        return reason;
    }

    const auto optional_bool = [&] (const char* key,
                               bool& target) -> std::optional<std::string> {
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, arg, key));
        if (JS_IsUndefined (value.get ()) || JS_IsNull (value.get ())) {
            return std::nullopt;
        }
        // Not JS_ToBool: a truthy string would make `secure: "false"` mean
        // secure, and a cookie's flags are not a place to guess.
        if (!JS_IsBool (value.get ())) {
            return "pm.cookies.jar().set cookie." + std::string (key) +
            " must be true or false, got " +
            std::string (js_type_name (ctx, value.get ()));
        }
        target = JS_ToBool (ctx, value.get ()) != 0;
        return std::nullopt;
    };
    if (auto reason = optional_bool ("secure", out.secure)) {
        return reason;
    }
    if (auto reason = optional_bool ("httpOnly", out.http_only)) {
        return reason;
    }

    ScopedValue js_expires (ctx, JS_GetPropertyStr (ctx, arg, "expires"));
    if (!JS_IsUndefined (js_expires.get ()) && !JS_IsNull (js_expires.get ())) {
        // Seconds since the epoch, which is what the jar stores and what a
        // Netscape line carries. A Date or a date string is refused with the
        // conversion rather than guessed at, because guessing wrong writes a
        // cookie that expires in 1970 and is simply never sent again.
        if (!JS_IsNumber (js_expires.get ())) {
            return "pm.cookies.jar().set cookie.expires must be a number of "
                   "seconds since the epoch (use Math.floor(date.getTime() / "
                   "1000)), got " +
            std::string (js_type_name (ctx, js_expires.get ()));
        }
        int64_t seconds = 0;
        if (JS_ToInt64 (ctx, &seconds, js_expires.get ()) < 0) {
            return std::string ("pm.cookies.jar().set cookie.expires is not a "
                                "whole number of seconds");
        }
        if (seconds < 0) {
            return std::string ("pm.cookies.jar().set cookie.expires must not "
                                "be negative; 0 means a session cookie");
        }
        out.expires = seconds;
    }
    return std::nullopt;
}

// A jar method's optional trailing callback, classified without invoking it.
enum class JarCallbackArg : std::uint8_t {
    /// None given - absent, `undefined` or `null`. The call is complete.
    Absent,
    /// A function, ready to be invoked inline.
    Present,
    /// Something else entirely; a TypeError is pending on @p ctx.
    Invalid,
};

// Split out of finish_jar_call so that a method which *stages* a write can
// check the callback slot before staging. **Every jar method validates all of
// its arguments before it stages anything** - jar().clear used to push a
// whole-jar wipe and only then discover the URL sitting where it expected a
// callback, so the script got a TypeError pointing away from a wipe that
// stayed staged and rode the next transfer regardless (issue #997).
JarCallbackArg classify_jar_callback (JSContext* ctx, int argc, JSValueConst* argv, int index) {
    if (index >= argc || JS_IsUndefined (argv[index]) || JS_IsNull (argv[index])) {
        return JarCallbackArg::Absent;
    }
    if (!JS_IsFunction (ctx, argv[index])) {
        JS_ThrowTypeError (ctx, "pm.cookies.jar()'s callback must be a function, got %s",
        js_type_name (ctx, argv[index]));
        return JarCallbackArg::Invalid;
    }
    return JarCallbackArg::Present;
}

// Postman's callback, honoured the way pm.sendRequest honours its own: the
// work already happened synchronously, so it is invoked inline with
// `(null, result)`. Optional, because the call is complete without it - and
// `result` is *also* returned, which a synchronous implementation can do
// honestly and a script reads more easily than a closure.
//
// Takes ownership of @p result either way.
JSValue finish_jar_call (JSContext* ctx, int argc, JSValueConst* argv, int callback_index, JSValue result) {
    const auto callback = classify_jar_callback (ctx, argc, argv, callback_index);
    if (callback == JarCallbackArg::Absent) {
        return result;
    }
    if (callback == JarCallbackArg::Invalid) {
        JS_FreeValue (ctx, result);
        return JS_EXCEPTION;
    }

    JSValue args[2] = { JS_NULL, JS_DupValue (ctx, result) };
    JSValue ret = JS_Call (ctx, argv[callback_index], JS_UNDEFINED, 2, args);
    JS_FreeValue (ctx, args[1]);
    // A callback that threw - a failed pm.expect inside it, most likely - is
    // the script's error, not something to swallow here.
    if (JS_IsException (ret)) {
        JS_FreeValue (ctx, result);
        return JS_EXCEPTION;
    }
    JS_FreeValue (ctx, ret);
    return result;
}

JSValue js_jar_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto url = read_jar_string_arg (ctx, "get", "URL", 0, argc, argv, /*url_arg=*/true);
    if (!url) {
        return JS_EXCEPTION;
    }
    auto name = read_jar_string_arg (ctx, "get", "cookie name", 1, argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto* data = jar_context (ctx, "jar().get");
    if (!data) {
        return JS_EXCEPTION;
    }

    // Matched against the URL given here rather than the request's, which is
    // the difference between this and the flat read half.
    const auto cookies = vayu::http::matching_in (staged_jar_lines (*data), *url);
    const auto* cookie = find_jar_cookie (cookies, *name);
    return finish_jar_call (ctx, argc, argv, 2,
    cookie ? JS_NewString (ctx, cookie->value.c_str ()) : JS_UNDEFINED);
}

JSValue js_jar_set (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto url = read_jar_string_arg (ctx, "set", "URL", 0, argc, argv, /*url_arg=*/true);
    if (!url) {
        return JS_EXCEPTION;
    }

    vayu::http::JarCookie cookie;
    int callback_index = 2;
    if (argc > 1 && JS_IsString (argv[1])) {
        // Postman's other spelling: set(url, name, value, cb). Both forms are
        // URL-scoped, which is the property decision 1 of #337 required.
        auto name = read_jar_string_arg (ctx, "set", "cookie name", 1, argc, argv);
        if (!name) {
            return JS_EXCEPTION;
        }
        if (argc < 3 || !JS_IsString (argv[2])) {
            return JS_ThrowTypeError (ctx, "pm.cookies.jar().set(url, name, value) needs a value string, got %s",
            argc < 3 ? "no argument" : js_type_name (ctx, argv[2]));
        }
        cookie.name    = std::move (*name);
        cookie.value   = js_to_string (ctx, argv[2]);
        callback_index = 3;
    } else if (auto reason =
               read_jar_cookie_arg (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, cookie)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }

    if (classify_jar_callback (ctx, argc, argv, callback_index) == JarCallbackArg::Invalid) {
        return JS_EXCEPTION;
    }

    auto* writes = jar_writes (ctx, "jar().set");
    if (!writes) {
        return JS_EXCEPTION;
    }

    // One helper builds the line for a written cookie and a received one alike
    // - see cookie_jar.hpp. It is also what fills the fields the object left
    // out, from the URL that scopes the call.
    const auto stored = vayu::http::cookie_for_url (*url, cookie);
    if (!stored) {
        return JS_ThrowTypeError (ctx,
        "pm.cookies.jar().set could not store \"%s\" for %s: the URL must be "
        "absolute and parseable, the name non-empty, and no field may contain "
        "a tab or newline",
        cookie.name.c_str (), url->c_str ());
    }
    writes->push_back ({ vayu::http::CookieWrite::Kind::Set,
    vayu::http::format_cookie_line (*stored), {}, {} });
    return finish_jar_call (ctx, argc, argv, callback_index, JS_UNDEFINED);
}

JSValue js_jar_unset (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto url = read_jar_string_arg (ctx, "unset", "URL", 0, argc, argv, /*url_arg=*/true);
    if (!url) {
        return JS_EXCEPTION;
    }
    auto name = read_jar_string_arg (ctx, "unset", "cookie name", 1, argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    if (classify_jar_callback (ctx, argc, argv, 2) == JarCallbackArg::Invalid) {
        return JS_EXCEPTION;
    }
    auto* writes = jar_writes (ctx, "jar().unset");
    if (!writes) {
        return JS_EXCEPTION;
    }
    writes->push_back ({ vayu::http::CookieWrite::Kind::Unset, {},
    std::move (*url), std::move (*name) });
    return finish_jar_call (ctx, argc, argv, 2, JS_UNDEFINED);
}

JSValue js_jar_clear (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    // Two forms, told apart by the first argument. Postman's is
    // `clear(url, cb?)`, scoped to one URL; Vayu's own `clear(cb?)` empties
    // the scope and is what this method shipped as. A string or a Url object in
    // that position is unambiguously the URL - the only other thing it takes is
    // a function.
    std::optional<std::string> url;
    int callback_index = 0;
    if (argc > 0 && (JS_IsString (argv[0]) || request_url_state (argv[0]) != nullptr)) {
        url = read_jar_string_arg (ctx, "clear", "URL", 0, argc, argv, /*url_arg=*/true);
        if (!url) {
            return JS_EXCEPTION;
        }
        // Refused rather than staged as a wipe that matches nothing: a clear
        // is destructive, so "cleared no cookies" and "was handed something
        // that is not a URL" must not read the same to the script.
        if (!vayu::http::url_can_scope_cookies (*url)) {
            return JS_ThrowTypeError (ctx,
            "pm.cookies.jar().clear could not scope to \"%s\": the URL must be "
            "absolute and parseable. Call clear() with no URL to empty this "
            "environment's jar.",
            url->c_str ());
        }
        callback_index = 1;
    }
    if (classify_jar_callback (ctx, argc, argv, callback_index) == JarCallbackArg::Invalid) {
        return JS_EXCEPTION;
    }

    auto* writes = jar_writes (ctx, "jar().clear");
    if (!writes) {
        return JS_EXCEPTION;
    }
    if (url) {
        // Scoped exactly as unset is - the cookies a request to this URL would
        // have carried - so the two spellings cannot disagree about what "this
        // URL's cookies" are.
        writes->push_back (
        { vayu::http::CookieWrite::Kind::ClearUrl, {}, std::move (*url), {} });
    } else {
        // The current environment's jar, and no other - decision 2 of #337. The
        // blast radius is a session reset, which Settings shows and a script can
        // legitimately want; it is not the whole process's cookies.
        writes->push_back ({ vayu::http::CookieWrite::Kind::Clear, {}, {}, {} });
    }
    return finish_jar_call (ctx, argc, argv, callback_index, JS_UNDEFINED);
}

// pm.cookies.jar() - Postman's jar object, built per call as Postman's is.
// Deliberately does *not* throw where there is no jar: it is an accessor, and
// the sentence explaining the absence belongs on the method the script
// actually called, so `typeof pm.cookies.jar().set` stays answerable.
JSValue js_cookies_jar (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue jar = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, jar, "get", JS_NewCFunction (ctx, js_jar_get, "get", 3));
    JS_SetPropertyStr (ctx, jar, "set", JS_NewCFunction (ctx, js_jar_set, "set", 4));
    JS_SetPropertyStr (ctx, jar, "unset", JS_NewCFunction (ctx, js_jar_unset, "unset", 3));
    JS_SetPropertyStr (ctx, jar, "clear", JS_NewCFunction (ctx, js_jar_clear, "clear", 2));
    return jar;
}

// pm.cookies - always bound, like pm.sendRequest, so a script that reaches for
// it where there is no jar is told why instead of meeting "not a function".
void setup_pm_cookies (JSContext* ctx, JSValue pm) {
    JSValue cookies = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, cookies, "get", JS_NewCFunction (ctx, js_jar_cookies_get, "get", 1));
    JS_SetPropertyStr (
    ctx, cookies, "has", JS_NewCFunction (ctx, js_jar_cookies_has, "has", 1));
    JS_SetPropertyStr (ctx, cookies, "toObject",
    JS_NewCFunction (ctx, js_jar_cookies_to_object, "toObject", 0));
    JS_SetPropertyStr (
    ctx, cookies, "jar", JS_NewCFunction (ctx, js_cookies_jar, "jar", 0));
    JS_SetPropertyStr (ctx, pm, "cookies", cookies);
}

// ============================================================================
// pm.execution - flow control (issue #355)
// ============================================================================

// The context a flow-control call may record on, or nullptr having thrown.
// Outside a scenario run there is no sequence to redirect, and the call is
// refused rather than accepted and dropped: `setNextRequest("checkout")`
// silently ignored in a single send is the false success issue #188's rule
// exists to prevent.
ContextData* execution_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data) {
        JS_ThrowInternalError (ctx, "No script context available");
        return nullptr;
    }
    if (!data->in_scenario) {
        JS_ThrowPlainError (ctx,
        "pm.execution.%s is not available here: it redirects a collection "
        "run's sequence, and this script is not running inside one. A single "
        "send has no next request, and a load run's test scripts run after the "
        "run has finished, against responses already recorded. See "
        "docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data;
}

// pm.execution.setNextRequest(name) - jump to the named step after this one
// completes; setNextRequest(null) ends the iteration (Postman's convention).
//
// The argument is required and must be a string or null. Omitting it is a
// TypeError rather than a synonym for null: "end the iteration" and "I forgot
// the name" are different intents, and guessing between them would silently
// end runs.
JSValue js_execution_set_next_request (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = execution_context (ctx, "setNextRequest");
    if (!data) {
        return JS_EXCEPTION;
    }

    if (argc < 1) {
        return JS_ThrowTypeError (ctx,
        "pm.execution.setNextRequest(name) needs a request name, or null to "
        "end this iteration - it was called with no argument");
    }
    if (JS_IsNull (argv[0])) {
        data->control = { ScriptControl::Kind::EndIteration, {} };
        return JS_UNDEFINED;
    }
    if (!JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "pm.execution.setNextRequest(name) needs a request name string, or "
        "null to end this iteration - got %s",
        js_type_name (ctx, argv[0]));
    }

    std::string target = js_to_string (ctx, argv[0]);
    if (target.empty ()) {
        return JS_ThrowTypeError (ctx,
        "pm.execution.setNextRequest(name) was given an empty name, which "
        "matches no request - pass a request's name, or null to end this "
        "iteration");
    }
    data->control = { ScriptControl::Kind::Next, std::move (target) };
    return JS_UNDEFINED;
}

// pm.execution.skipRequest() - do not send this step.
//
// Pre-request only. In a test script the request has already gone out and
// there is nothing left to skip, so the call throws instead of recording an
// intent the runner would have to refuse afterwards.
JSValue js_execution_skip_request (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = execution_context (ctx, "skipRequest");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (data->event && *data->event == ScriptEvent::Test) {
        return JS_ThrowPlainError (ctx,
        "pm.execution.skipRequest() can only be called from a pre-request "
        "script: by the time a test script runs, the request has already been "
        "sent and there is nothing left to skip.");
    }
    data->control = { ScriptControl::Kind::Skip, {} };
    return JS_UNDEFINED;
}

// pm.execution - always bound, like pm.cookies, so a script that reaches for it
// outside a collection run is told why rather than meeting "not a function".
void setup_pm_execution (JSContext* ctx, JSValue pm) {
    JSValue execution = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, execution, "setNextRequest",
    JS_NewCFunction (ctx, js_execution_set_next_request, "setNextRequest", 1));
    JS_SetPropertyStr (ctx, execution, "skipRequest",
    JS_NewCFunction (ctx, js_execution_skip_request, "skipRequest", 0));
    JS_SetPropertyStr (ctx, pm, "execution", execution);
}

// ============================================================================
// pm.iterationData - the data row bound to this iteration (issue #356)
// ============================================================================

// Turn one JSON value from the row into a JS value.
//
// Dump-and-parse rather than a hand-written walk: a data row is arbitrary JSON,
// and QuickJS's own parser already accepts exactly that - nested objects,
// arrays, `null`, numbers no double-only converter would keep. A second
// implementation here would be a copy that stops receiving the parser's fixes.
// `replace` on the dump because a row is user data: a lone UTF-8 continuation
// byte must become U+FFFD, not throw out of a getter.
JSValue js_from_json (JSContext* ctx, const nlohmann::json& value, const char* label) {
    const std::string dumped =
    value.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    JSValue parsed = JS_ParseJSON (ctx, dumped.c_str (), dumped.size (), "<iterationData>");
    if (JS_IsException (parsed)) {
        JS_FreeValue (ctx, parsed);
        // Clear QuickJS's own exception before replacing it with one that says
        // which value failed - the raw parse error names only a column.
        JSValue pending = JS_GetException (ctx);
        JS_FreeValue (ctx, pending);
        return JS_ThrowPlainError (ctx,
        "pm.iterationData could not read %s from this iteration's data row - "
        "the value is not representable as JSON",
        label);
    }
    return parsed;
}

// The row this script is bound to, or null with a TypeError already thrown.
//
// `pm.iterationData` is only an object when a row exists, so the ordinary way
// to reach these functions already implies one. The check is for the way that
// does not: the global object survives a pooled context, so a script can stash
// `pm.iterationData` and a later script running in the same context can call
// what it stashed. That call reads the *current* execution's row - none - and
// must say so rather than answering about a run that has finished.
//
// The message names every surface that binds a row, not just the collection run
// #356 shipped with: #402 made a send-with-row one and #599 made a scenario load
// run's deferred per-step script another, so a message naming only collection
// runs steers a user who stashed the object during either of those to look for a
// mistake that is not there.
ContextData* iteration_data_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data || !data->iteration_data) {
        JS_ThrowTypeError (ctx,
        "pm.iterationData.%s is not available here: this script has no data "
        "row "
        "bound. A row is bound by an iteration of a collection run with a data "
        "set, by a send-with-row, and by a scenario load run's deferred "
        "per-step script. See docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data;
}

// pm.iterationData.get(key) - the row's value for `key`, or `undefined`.
//
// An unknown key is `undefined`, matching every other `pm` scope reader; the
// argument is coerced the way `pm.variables.get` coerces it, so the two scopes
// answer a non-string key identically.
JSValue js_iteration_data_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = iteration_data_context (ctx, "get");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    const std::string key = js_to_string (ctx, argv[0]);
    const auto found      = data->iteration_data->find (key);
    if (found == data->iteration_data->end ()) {
        return JS_UNDEFINED;
    }
    return js_from_json (ctx, *found, key.c_str ());
}

// pm.iterationData.has(key) - whether the row carries that column.
//
// Every other scope reader in the pm surface answers `has` - pm.environment,
// pm.globals, pm.collectionVariables, pm.variables and pm.cookies all do - and
// Postman's pm.iterationData is a VariableScope, which has one too. Absent, the
// question has to be asked as `get(key) !== undefined`, which is both indirect
// and easy to write wrongly for a column whose value is JSON `null`.
//
// A column that is present and null is `true` here: the row carries it. That is
// the one answer `get` cannot phrase as a presence check without the reader
// knowing that a null column comes back as JS `null` rather than `undefined`.
JSValue js_iteration_data_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = iteration_data_context (ctx, "has");
    if (!data) {
        return JS_EXCEPTION;
    }
    // No argument is "no such column", the same answer pm.variables.has gives.
    if (argc < 1) {
        return JS_NewBool (ctx, 0);
    }

    const std::string key = js_to_string (ctx, argv[0]);
    return JS_NewBool (ctx, data->iteration_data->contains (key) ? 1 : 0);
}

// pm.iterationData.toObject() - the whole row, as a plain object.
JSValue js_iteration_data_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = iteration_data_context (ctx, "toObject");
    if (!data) {
        return JS_EXCEPTION;
    }
    return js_from_json (ctx, *data->iteration_data, "this row");
}

// pm.iterationData.set / unset / clear - refused, loudly.
//
// The rows are a run *input*, not a scope: there is no destination a write
// could land in, no persistence story for one, and the next iteration binds a
// different row regardless. Accepting the call and dropping the value is
// exactly #188's false success, so the write is bound and throws rather than
// being absent and answering "not a function" - which reads as a gap in the
// engine rather than as a decision.
JSValue js_iteration_data_write (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError (ctx,
    "pm.iterationData is read-only: the data rows are an input to this run, "
    "not a variable scope, so a write here would have nowhere to land. Use "
    "pm.environment, pm.collectionVariables or pm.globals to carry a value on "
    "from a row.");
}

// pm.iterationData - the row, or `undefined` when the run has no data set.
//
// Rebuilt per execution beside pm.info, and cleared rather than left standing
// when there is no row: contexts are pooled, so the previous step's object
// would otherwise answer a single send with the last collection run's data.
//
// Absence is `undefined` and not an empty scope - see
// `ScriptContext::iteration_data` for why this one binding differs from
// pm.execution and pm.cookies.
void setup_pm_iteration_data (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    JSValue previous = JS_GetPropertyStr (ctx, pm, "iterationData");
    if (!JS_IsUndefined (previous)) {
        JS_FreeValue (ctx, previous);
    }

    if (!data || !data->iteration_data) {
        JS_SetPropertyStr (ctx, pm, "iterationData", JS_UNDEFINED);
        return;
    }

    JSValue iteration_data = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, iteration_data, "get",
    JS_NewCFunction (ctx, js_iteration_data_get, "get", 1));
    JS_SetPropertyStr (ctx, iteration_data, "has",
    JS_NewCFunction (ctx, js_iteration_data_has, "has", 1));
    JS_SetPropertyStr (ctx, iteration_data, "toObject",
    JS_NewCFunction (ctx, js_iteration_data_to_object, "toObject", 0));
    for (const char* writer : { "set", "unset", "clear" }) {
        JS_SetPropertyStr (ctx, iteration_data, writer,
        JS_NewCFunction (ctx, js_iteration_data_write, writer, 2));
    }
    JS_SetPropertyStr (ctx, pm, "iterationData", iteration_data);
}

void setup_pm_object (JSContext* ctx) {
    JSValue global = JS_GetGlobalObject (ctx);
    JSValue pm     = JS_NewObject (ctx);

    // A class registered with JS_NewClass has no prototype until one is set, so
    // without this the pm.response.to.* objects would answer nothing but their
    // own members - toString, hasOwnProperty and friends would reach the
    // unknown-member hook and throw.
    JSValue plain        = JS_NewObject (ctx);
    JSValue object_proto = JS_GetPrototype (ctx, plain);
    JS_FreeValue (ctx, plain);
    JS_SetClassProto (ctx, response_chain_class_id, object_proto);

    // `pm.request.url` inherits from **String.prototype**, which is the whole
    // of how `url.startsWith(...)`, `.includes(...)`, `.slice(...)` and the
    // rest keep working on what used to be a string: every one of them coerces
    // through `ToString(this)`, which the object's own `@@toPrimitive` answers
    // with the URL. What it does not restore is `.length` - an own property of
    // a real string, and one of the three breaks #991 documents.
    JSValue string_ctor  = JS_GetPropertyStr (ctx, global, "String");
    JSValue string_proto = JS_GetPropertyStr (ctx, string_ctor, "prototype");
    JS_FreeValue (ctx, string_ctor);
    JS_SetClassProto (ctx, request_url_class_id, string_proto);

    // pm.test()
    JS_SetPropertyStr (ctx, pm, "test", JS_NewCFunction (ctx, js_pm_test, "test", 2));

    // pm.expect()
    JS_SetPropertyStr (ctx, pm, "expect", JS_NewCFunction (ctx, js_pm_expect, "expect", 1));

    // pm.response
    setup_pm_response (ctx, pm);

    // pm.request
    setup_pm_request (ctx, pm);

    // pm.info
    setup_pm_info (ctx, pm);

    // pm.iterationData - present only for a data-driven collection run's steps
    // (issue #356), so it is refreshed per execution like pm.info.
    setup_pm_iteration_data (ctx, pm);

    // pm.environment, pm.globals, pm.collectionVariables
    for (const auto& binding : variable_scope_bindings) {
        setup_pm_variable_scope (ctx, pm, binding);
    }

    // pm.variables
    setup_pm_variables (ctx, pm);

    // pm.crypto
    setup_pm_crypto (ctx, pm);

    // pm.cookies - the jar's flat read half (issue #301) and, through
    // `jar()`, its write half (issue #337).
    setup_pm_cookies (ctx, pm);

    // pm.execution - flow control (issue #355), bound the same way and for the
    // same reason: outside a collection run it explains itself rather than
    // being absent.
    setup_pm_execution (ctx, pm);

    // pm.sendRequest - always bound, even when the capability is off, so a
    // script that calls it gets a sentence explaining why rather than
    // "not a function".
    JS_SetPropertyStr (ctx, pm, "sendRequest",
    JS_NewCFunction (ctx, js_pm_send_request, "sendRequest", 2));

    JS_SetPropertyStr (ctx, global, "pm", pm);
    JS_FreeValue (ctx, global);
}

} // anonymous namespace

// ============================================================================
// ScriptEngine Implementation
// ============================================================================

// QuickJS calls this periodically during evaluation. Returning non-zero aborts
// the current JS_Eval with an InternalError, which the execute() exception path
// turns into result.error_message.
extern "C" int script_interrupt_handler (JSRuntime* /*rt*/, void* opaque) {
    auto* state = static_cast<RuntimeState*> (opaque);
    if (!state || !state->enabled)
        return 0;
    return std::chrono::steady_clock::now () > state->deadline ? 1 : 0;
}

class ScriptEngine::Impl {
    public:
    ScriptConfig config;
    // Pool of Runtime+Context pairs
    // We need separate runtimes because QuickJS JSRuntime is not thread-safe
    using ContextPair = std::pair<JSRuntime*, JSContext*>;
    std::vector<ContextPair> context_pool;
    std::mutex pool_mutex;

    explicit Impl (const ScriptConfig& cfg) : config (cfg) {
    }

    ~Impl () {
        std::lock_guard<std::mutex> lock (pool_mutex);
        for (auto& pair : context_pool) {
            auto* rt_state =
            static_cast<RuntimeState*> (JS_GetRuntimeOpaque (pair.first));
            JS_FreeContext (pair.second);
            JS_FreeRuntime (pair.first);
            delete rt_state;
        }
        context_pool.clear ();
    }

    ContextPair acquire_context () {
        std::lock_guard<std::mutex> lock (pool_mutex);
        if (!context_pool.empty ()) {
            ContextPair pair = context_pool.back ();
            context_pool.pop_back ();
            return pair;
        }

        // Create new runtime and context
        JSRuntime* rt = JS_NewRuntime ();
        if (!rt)
            return { nullptr, nullptr };

        JS_SetMemoryLimit (rt, config.memory_limit);
        JS_SetMaxStackSize (rt, config.stack_size);

        // Install a wall-clock deadline interrupt so infinite-loop scripts
        // cannot hang the thread. The RuntimeState is owned by this runtime
        // (freed in ~Impl) and refreshed before each execute().
        auto* rt_state = new RuntimeState ();
        JS_SetRuntimeOpaque (rt, rt_state);
        JS_SetInterruptHandler (rt, &script_interrupt_handler, rt_state);

        // Register Expectation class
        if (expect_class_id == 0) {
            JS_NewClassID (rt, &expect_class_id);
        }
        JS_NewClass (rt, expect_class_id, &expect_class);

        // Register the pm.response.to.* chain class, whose exotic hook makes an
        // unknown assertion throw instead of silently evaluating to undefined.
        if (response_chain_class_id == 0) {
            JS_NewClassID (rt, &response_chain_class_id);
        }
        JS_NewClass (rt, response_chain_class_id, &response_chain_class);

        // Register the pm.request.url class - see setup_pm_object for the
        // prototype that keeps it usable as the string it replaced.
        if (request_url_class_id == 0) {
            JS_NewClassID (rt, &request_url_class_id);
        }
        JS_NewClass (rt, request_url_class_id, &request_url_class);

        JSContext* ctx = JS_NewContext (rt);
        if (ctx) {
            if (config.enable_console) {
                setup_console (ctx);
            }
            setup_base64_globals (ctx);
            setup_pm_object (ctx);
        } else {
            JS_FreeRuntime (rt);
            return { nullptr, nullptr };
        }

        return { rt, ctx };
    }

    void release_context (ContextPair pair) {
        if (!pair.first || !pair.second)
            return;

        // Run garbage collection before returning to pool to free any unreferenced objects
        // This prevents memory buildup from script execution
        JS_RunGC (pair.first);

        std::lock_guard<std::mutex> lock (pool_mutex);
        context_pool.push_back (pair);
    }

    ScriptResult execute (const std::string& script, const ScriptContext& ctx) {
        ScriptResult result;

        // Acquire runtime/context pair
        ContextPair pair  = acquire_context ();
        JSRuntime* rt     = pair.first;
        JSContext* js_ctx = pair.second;

        if (!rt || !js_ctx) {
            result.success       = false;
            result.error_message = "Failed to create QuickJS runtime/context";
            return result;
        }

        // Refresh the per-execution deadline. A pooled context reused for the next
        // script gets a fresh budget; timeout_ms == 0 disables the wall-clock limit.
        if (auto* rt_state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (rt))) {
            rt_state->enabled = config.timeout_ms != 0;
            if (rt_state->enabled) {
                rt_state->deadline = std::chrono::steady_clock::now () +
                std::chrono::milliseconds (config.timeout_ms);
            }
        }

        // Set up context data
        ContextData ctx_data;
        ctx_data.request             = ctx.request;
        ctx_data.response            = ctx.response;
        ctx_data.environment         = ctx.environment;
        ctx_data.globals             = ctx.globals;
        ctx_data.collectionVariables = ctx.collectionVariables;
        ctx_data.collectionAncestors = ctx.collectionAncestors;
        ctx_data.request_id          = ctx.request_id;
        ctx_data.request_name        = ctx.request_name;
        ctx_data.event               = ctx.event;
        ctx_data.iteration           = ctx.iteration;
        ctx_data.iteration_count     = ctx.iteration_count;
        ctx_data.iteration_data      = ctx.iteration_data;
        ctx_data.response_events     = ctx.response_events;
        // Both per-execution: the capability is this caller's, and the request
        // budget starts full for every script rather than carrying over
        // through a pooled context.
        ctx_data.allow_send_request = config.allow_send_request;
        ctx_data.send_request_count = 0;
        ctx_data.cookie_jar         = ctx.cookie_jar;
        ctx_data.cookie_scope       = ctx.cookie_scope;
        ctx_data.cookie_writes      = ctx.cookie_writes;
        ctx_data.transport          = ctx.transport;
        ctx_data.in_scenario        = ctx.in_scenario;
        JS_SetContextOpaque (js_ctx, &ctx_data);

        // Refresh pm.request, pm.response, pm.info and pm.iterationData with
        // new data
        JSValue global = JS_GetGlobalObject (js_ctx);
        JSValue pm     = JS_GetPropertyStr (js_ctx, global, "pm");
        if (!JS_IsUndefined (pm)) {
            setup_pm_response (js_ctx, pm);
            setup_pm_request (js_ctx, pm);
            setup_pm_info (js_ctx, pm);
            setup_pm_iteration_data (js_ctx, pm);
        }
        JS_FreeValue (js_ctx, pm);
        JS_FreeValue (js_ctx, global);

        // Wrap script in IIFE to avoid global scope pollution
        std::string wrapped_script = "(function() { " + script + " \n})()";

        // Execute script
        JSValue eval_result = JS_Eval (js_ctx, wrapped_script.c_str (),
        wrapped_script.size (), "<script>", JS_EVAL_TYPE_GLOBAL);

        if (JS_IsException (eval_result)) {
            JSValue exc    = JS_GetException (js_ctx);
            result.success = false;
            // If the deadline interrupt fired, report a clear timeout message
            // rather than QuickJS's raw "interrupted" InternalError.
            auto* rt_state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (rt));
            if (rt_state && rt_state->enabled &&
            std::chrono::steady_clock::now () > rt_state->deadline) {
                result.error_message = "Script execution timed out after " +
                std::to_string (config.timeout_ms) + "ms";
            } else {
                result.error_message = js_to_string (js_ctx, exc);
            }
            JS_FreeValue (js_ctx, exc);
        } else {
            result.success = true;
        }

        JS_FreeValue (js_ctx, eval_result);

        // Apply the script's pm.request edits to the request that is about to
        // be sent. Deliberately runs even when the script threw: the edits it
        // made before throwing already happened, the request is sent either
        // way, and discarding them silently is the defect this replaced.
        if (ctx.mutable_request) {
            if (auto reason = apply_pm_request_writeback (js_ctx, *ctx.mutable_request)) {
                result.success       = false;
                result.error_message = result.error_message.empty () ?
                *reason :
                result.error_message + " (and pm.request was not applied: " + *reason + ")";
            }
        }

        // Copy results
        result.tests          = std::move (ctx_data.tests);
        result.console_output = std::move (ctx_data.console_output);
        // Carried even when the script threw afterwards: the caller decides
        // what an instruction from a script that then failed is worth, and the
        // scenario runner ends the iteration on an errored step regardless.
        result.control = std::move (ctx_data.control);

        // Check if any tests failed
        for (const auto& test : result.tests) {
            if (!test.passed) {
                result.success = false;
                break;
            }
        }

        // Return context to pool
        release_context (pair);
        return result;
    }
};

ScriptEngine::ScriptEngine (const ScriptConfig& config)
: impl_ (std::make_unique<Impl> (config)) {
}

ScriptEngine::~ScriptEngine () = default;

ScriptEngine::ScriptEngine (ScriptEngine&&) noexcept            = default;
ScriptEngine& ScriptEngine::operator= (ScriptEngine&&) noexcept = default;

ScriptResult ScriptEngine::execute (const std::string& script, const ScriptContext& ctx) {
    return impl_->execute (script, ctx);
}

ScriptResult ScriptEngine::execute_prerequest (const std::string& script,
Request& request,
Environment& env) {
    ScriptContext ctx = ScriptContext::for_prerequest (request);
    ctx.environment   = &env;
    return execute (script, ctx);
}

ScriptResult ScriptEngine::execute_test (const std::string& script,
const Request& request,
const Response& response,
Environment& env) {
    ScriptContext ctx = ScriptContext::for_test (request, response);
    ctx.environment   = &env;
    return execute (script, ctx);
}

bool ScriptEngine::is_available () {
    return true;
}

std::string ScriptEngine::version () {
    // Derived from the vendored runtime, never written down here: a literal
    // goes stale at the next vendor bump with nothing to catch it. This one
    // reported "QuickJS 2024-01-13" while the tree carried quickjs-ng 0.16.0.
    return std::string ("QuickJS-ng ") + JS_GetVersion ();
}

#else // !VAYU_HAS_QUICKJS

// ============================================================================
// Stub Implementation (No QuickJS)
// ============================================================================

class ScriptEngine::Impl {};

ScriptEngine::ScriptEngine (const ScriptConfig&) : impl_ (nullptr) {
}

ScriptEngine::~ScriptEngine ()                                  = default;
ScriptEngine::ScriptEngine (ScriptEngine&&) noexcept            = default;
ScriptEngine& ScriptEngine::operator= (ScriptEngine&&) noexcept = default;

ScriptResult ScriptEngine::execute (const std::string&, const ScriptContext&) {
    ScriptResult result;
    result.success       = false;
    result.error_message = "Scripting not available (QuickJS not compiled)";
    return result;
}

ScriptResult ScriptEngine::execute_prerequest (const std::string&, Request&, Environment&) {
    ScriptResult result;
    result.success       = false;
    result.error_message = "Scripting not available (QuickJS not compiled)";
    return result;
}

ScriptResult
ScriptEngine::execute_test (const std::string&, const Request&, const Response&, Environment&) {
    ScriptResult result;
    result.success       = false;
    result.error_message = "Scripting not available (QuickJS not compiled)";
    return result;
}

bool ScriptEngine::is_available () {
    return false;
}

std::string ScriptEngine::version () {
    return "";
}

#endif // VAYU_HAS_QUICKJS

} // namespace vayu::runtime
