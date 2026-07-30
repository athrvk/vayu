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
 */

// NOLINTBEGIN

#include "vayu/runtime/script_engine.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <iterator>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "vayu/http/status.hpp"
#include "vayu/utils/json.hpp"

#ifdef VAYU_HAS_QUICKJS
// Disable warnings for QuickJS C header in C++ code
#if defined(__clang__) || defined(__GNUC__)
#pragma GCC diagnostic push
#if defined(__clang__)
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

// Compatibility macros for QuickJS vs QuickJS-NG API differences
#ifdef _WIN32
// QuickJS-NG (Windows): JS_IsArray takes 1 arg, JS_NewClassID takes 2 args
#define QJS_IsArray(ctx, val) JS_IsArray (val)
#define QJS_NewClassID(rt, pclass_id) JS_NewClassID (rt, pclass_id)
#else
// Original QuickJS (Unix): JS_IsArray takes 2 args, JS_NewClassID takes 1 arg
#define QJS_IsArray(ctx, val) JS_IsArray (ctx, val)
#define QJS_NewClassID(rt, pclass_id) JS_NewClassID (pclass_id)
#endif

#endif

namespace vayu::runtime {

#ifdef VAYU_HAS_QUICKJS

// ============================================================================
// QuickJS Helper Functions
// ============================================================================

namespace {
// Context data stored in JS runtime
struct ContextData {
    std::vector<TestResult> tests;
    std::vector<std::string> console_output;
    const Request* request           = nullptr;
    const Response* response         = nullptr;
    Environment* environment         = nullptr;
    Environment* globals             = nullptr;
    Environment* collectionVariables = nullptr;
    bool has_error                   = false;
    std::string error_message;
};

// Get context data from JS context
ContextData* get_context_data (JSContext* ctx) {
    return static_cast<ContextData*> (JS_GetContextOpaque (ctx));
}

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
        while (!lowered.empty () && isspace_pred (lowered.front ()))
            lowered.erase (lowered.begin ());
        while (!lowered.empty () && isspace_pred (lowered.back ()))
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

JSValue js_console_log (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
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
            JSValue json   = JS_JSONStringify (ctx, argv[i], JS_UNDEFINED, indent);
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

    data->console_output.push_back (ss.str ());
    return JS_UNDEFINED;
}

void setup_console (JSContext* ctx) {
    JSValue global  = JS_GetGlobalObject (ctx);
    JSValue console = JS_NewObject (ctx);

    JS_SetPropertyStr (
    ctx, console, "log", JS_NewCFunction (ctx, js_console_log, "log", 1));
    JS_SetPropertyStr (
    ctx, console, "info", JS_NewCFunction (ctx, js_console_log, "info", 1));
    JS_SetPropertyStr (
    ctx, console, "warn", JS_NewCFunction (ctx, js_console_log, "warn", 1));
    JS_SetPropertyStr (
    ctx, console, "error", JS_NewCFunction (ctx, js_console_log, "error", 1));

    JS_SetPropertyStr (ctx, global, "console", console);
    JS_FreeValue (ctx, global);
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
        return JS_IsBool (a) && JS_IsBool (b) &&
        JS_ToBool (ctx, a) == JS_ToBool (ctx, b);
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
std::string js_class_tag (JSContext* ctx, JSValueConst val) {
    JSValue global    = JS_GetGlobalObject (ctx);
    JSValue ctor      = JS_GetPropertyStr (ctx, global, "Object");
    JSValue proto     = JS_GetPropertyStr (ctx, ctor, "prototype");
    JSValue to_string = JS_GetPropertyStr (ctx, proto, "toString");

    std::string tag;
    if (JS_IsFunction (ctx, to_string)) {
        JSValue result = JS_Call (ctx, to_string, val, 0, nullptr);
        if (!JS_IsException (result)) {
            tag = js_to_string (ctx, result);
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

// A cyclic structure would recurse forever; the cap turns that into a thrown
// error rather than a stack overflow. Nothing a script asserts on legitimately
// nests this far.
constexpr int kDeepEqualMaxDepth = 64;

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
int js_deep_equal (JSContext* ctx, JSValueConst a, JSValueConst b, int depth) {
    if (depth > kDeepEqualMaxDepth) {
        JS_ThrowRangeError (ctx,
        "deep equality gave up after %d levels - the compared values are cyclic "
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

    const std::string tag = js_class_tag (ctx, a);
    if (tag != js_class_tag (ctx, b)) {
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
            const int same = js_deep_equal (ctx, a_elem, b_elem, depth + 1);
            JS_FreeValue (ctx, a_elem);
            JS_FreeValue (ctx, b_elem);
            if (same != 1) {
                return same;
            }
        }
        return 1;
    }

    std::vector<std::string> a_keys, b_keys;
    if (!js_own_enumerable_keys (ctx, a, a_keys) ||
    !js_own_enumerable_keys (ctx, b, b_keys)) {
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
        JSValue a_val  = JS_GetPropertyStr (ctx, a, key.c_str ());
        JSValue b_val  = JS_GetPropertyStr (ctx, b, key.c_str ());
        const int same = js_deep_equal (ctx, a_val, b_val, depth + 1);
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
    return deep ? js_deep_equal (ctx, a, b, 0) : (js_strict_equal (ctx, a, b) ? 1 : 0);
}

JSValue expect_to_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    // "to" just returns this for chaining
    return JS_DupValue (ctx, this_val);
}

JSValue expect_not_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (state) {
        state->negated = !state->negated;
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
JSValue expect_equality (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
bool always_deep) {
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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

    if (JS_IsString (state->actual)) {
        std::string str    = js_to_string (ctx, state->actual);
        std::string substr = js_to_string (ctx, argv[0]);
        includes           = str.find (substr) != std::string::npos;
    } else if (QJS_IsArray (ctx, state->actual)) {
        JSValue length = JS_GetPropertyStr (ctx, state->actual, "length");
        uint32_t len;
        JS_ToUint32 (ctx, &len, length);
        JS_FreeValue (ctx, length);

        // Membership follows the chain's comparison rule. It used to compare
        // `JS_ToCString` forms, under which every object member matched every
        // object needle - both render as "[object Object]".
        for (uint32_t i = 0; i < len && !includes; i++) {
            JSValue elem   = JS_GetPropertyUint32 (ctx, state->actual, i);
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
        (state->negated ? " to not include " : " to include ") + js_describe (ctx, argv[0]);
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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

    const std::string prop_name = js_to_string (ctx, argv[0]);
    const std::vector<std::string> segments =
    state->nested ? split_property_path (prop_name) :
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
    } else if (QJS_IsArray (ctx, state->actual)) {
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
        return JS_ThrowTypeError (ctx, "%s", msg);
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
    } else if (QJS_IsArray (ctx, state->actual)) {
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
    }

    return expect_chained (ctx, this_val);
}

// Matchers a Postman suite reaches for that used to throw "not a function".
// Each one fails loudly on an argument it cannot use, because a matcher that
// quietly accepts anything is the false-pass this series exists to remove.

JSValue expect_one_of (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !QJS_IsArray (ctx, argv[0])) {
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
        const int same = js_compare_for_chain (ctx, state->actual, candidate, state->deep);
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
    if (argc == 1 && QJS_IsArray (ctx, argv[0])) {
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_members (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !QJS_IsArray (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "members() requires an array");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!QJS_IsArray (ctx, state->actual)) {
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        std::string msg = state->negated ? "Expected the function to not throw" :
                                           "Expected the function to throw";
        if (threw) {
            msg += ", but it threw " + thrown;
        }
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        JSValue name_val      = JS_GetPropertyStr (ctx, argv[0], "name");
        const std::string ctor_name = js_to_string (ctx, name_val);
        JS_FreeValue (ctx, name_val);
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be an instance of " : " to be an instance of ") +
        ctor_name;
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
    JS_ToFloat64 (ctx, &expected, argv[0]) < 0 || JS_ToFloat64 (ctx, &delta, argv[1]) < 0) {
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
    }

    return expect_chained (ctx, this_val);
}

JSValue create_expectation (JSContext* ctx, JSValue actual) {
    JSValue obj = JS_NewObjectClass (ctx, static_cast<int> (expect_class_id));
    if (JS_IsException (obj)) {
        return obj;
    }

    auto* state = new ExpectState{ JS_DupValue (ctx, actual), false };
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
    JS_SetPropertyStr (
    ctx, obj, "oneOf", JS_NewCFunction (ctx, expect_one_of, "oneOf", 1));
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

    return create_expectation (ctx, argv[0]);
}

JSValue js_response_json (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    JSValue json = JS_ParseJSON (ctx, data->response->body.c_str (),
    data->response->body.size (), "<response>");
    if (JS_IsException (json)) {
        return JS_ThrowTypeError (ctx, "Response body is not valid JSON");
    }

    return json;
}

JSValue js_response_text (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    return JS_NewString (ctx, data->response->body.c_str ());
}

// ============================================================================
// pm.response.to.have Assertions (Postman-compatible)
// ============================================================================

JSValue js_response_have_status (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "status() requires an expected status code");
    }

    auto* data = get_context_data (ctx);
    if (!data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }

    int32_t expected_status;
    if (JS_ToInt32 (ctx, &expected_status, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "status() expects a number");
    }

    if (data->response->status_code != expected_status) {
        std::string msg = "Expected status code " + std::to_string (expected_status) +
        " but got " + std::to_string (data->response->status_code);
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
    }

    // If a second argument is provided, check the value
    if (argc >= 2) {
        std::string expected_value = js_to_string (ctx, argv[1]);
        if (found_value != expected_value) {
            std::string msg = "Expected header '" + header_name + "' to be '" +
            expected_value + "' but got '" + found_value + "'";
            return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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

    std::string expected = js_to_string (ctx, argv[0]);

    if (data->response->body.find (expected) == std::string::npos) {
        std::string msg = "Expected response body to contain '" + expected + "'";
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "Response body is not valid JSON");
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
            return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
        }

        if (end == std::string::npos)
            break;
        start = end + 1;
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
    { "ok", 200, 299, "a 2xx status code" },
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
JSValue js_response_be_status_class (
JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
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
        return JS_ThrowTypeError (ctx, "%s", msg.c_str ());
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
        return JS_ThrowTypeError (ctx, "Expected response body to be valid JSON");
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
        return JS_ThrowTypeError (ctx, "Expected response to have a body");
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

int response_chain_unknown_member (
JSContext* ctx, JSPropertyDescriptor* desc, JSValueConst obj, JSAtom prop) {
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
    JSValue proto      = JS_GetPrototype (ctx, obj);
    const int on_proto = JS_IsObject (proto) ? JS_HasProperty (ctx, proto, prop) : 0;
    JS_FreeValue (ctx, proto);
    if (on_proto != 0) {
        return on_proto < 0 ? -1 : 0;
    }

    const std::string msg = std::string (path) + "." + name + " is not a supported assertion";
    JS_ThrowTypeError (ctx, "%s", msg.c_str ());
    return -1;
}

JSClassExoticMethods response_chain_exotic = {
    .get_own_property = response_chain_unknown_member,
};

JSClassDef response_chain_class = { .class_name = "ResponseAssertionChain",
    .finalizer                                  = nullptr,
    .gc_mark                                    = nullptr,
    .call                                       = nullptr,
    .exotic                                     = &response_chain_exotic };

JSValue create_response_chain_object (JSContext* ctx) {
    return JS_NewObjectClass (ctx, static_cast<int> (response_chain_class_id));
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
    if (QJS_IsArray (ctx, value))
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

void define_header_entry (JSContext* ctx, JSValue headers, const std::string& name, const std::string& value) {
    JS_DefinePropertyValueStr (
    ctx, headers, name.c_str (), JS_NewString (ctx, value.c_str ()), JS_PROP_C_W_E);
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
std::optional<std::string>
find_header_key (JSContext* ctx, JSValueConst headers, const std::string& name) {
    JSPropertyEnum* props = nullptr;
    uint32_t count        = 0;
    if (JS_GetOwnPropertyNames (ctx, &props, &count, headers,
        JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
        return std::nullopt;
    }

    std::optional<std::string> found;
    for (uint32_t i = 0; i < count; i++) {
        if (!found) {
            const char* raw = JS_AtomToCString (ctx, props[i].atom);
            if (raw) {
                if (header_names_equal (raw, name)) {
                    found = std::string (raw);
                }
                JS_FreeCString (ctx, raw);
            }
        }
        JS_FreeAtom (ctx, props[i].atom);
    }
    js_free (ctx, props);
    return found;
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
std::optional<std::string>
read_header_value_arg (JSContext* ctx, const char* member, const std::string& name, JSValueConst value) {
    if (JS_IsString (value) || JS_IsNumber (value) || JS_IsBool (value)) {
        return js_to_string (ctx, value);
    }
    JS_ThrowTypeError (ctx,
    "headers.%s: value for '%s' must be a string, number or boolean, got %s",
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

JSValue js_headers_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "has")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "has", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    return JS_NewBool (ctx, find_header_key (ctx, this_val, *name).has_value ());
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
    !QJS_IsArray (ctx, argv[0])) {
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

    JS_ThrowTypeError (ctx,
    "headers.%s takes ({ key, value }) or (name, value)", member);
    return std::nullopt;
}

// magic: 0 = add (refuses an existing name), 1 = upsert (replaces it).
JSValue js_request_headers_add_or_upsert (
JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
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
    JS_DefinePropertyValueStr (ctx, headers, "get",
    JS_NewCFunction (ctx, js_headers_get, "get", 1), HEADER_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, headers, "has",
    JS_NewCFunction (ctx, js_headers_has, "has", 1), HEADER_METHOD_FLAGS);

    if (!mutators) {
        return;
    }
    JS_DefinePropertyValueStr (ctx, headers, "add",
    JS_NewCFunctionMagic (ctx, js_request_headers_add_or_upsert, "add", 2, JS_CFUNC_generic_magic, 0),
    HEADER_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, headers, "upsert",
    JS_NewCFunctionMagic (ctx, js_request_headers_add_or_upsert, "upsert", 2, JS_CFUNC_generic_magic, 1),
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
    if (!data->response->status_text.empty ()) {
        return JS_NewString (ctx, data->response->status_text.c_str ());
    }
    return JS_NewString (
    ctx, vayu::http::status_text (data->response->status_code).c_str ());
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
    JS_SetPropertyStr (ctx, size, "body", JS_NewInt64 (ctx, static_cast<int64_t> (body_bytes)));
    JS_SetPropertyStr (ctx, size, "header", JS_NewInt64 (ctx, static_cast<int64_t> (header_bytes)));
    JS_SetPropertyStr (ctx, size, "total",
    JS_NewInt64 (ctx, static_cast<int64_t> (body_bytes + header_bytes)));
    return size;
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

        // pm.response.json()
        JS_SetPropertyStr (ctx, response, "json",
        JS_NewCFunction (ctx, js_response_json, "json", 0));

        // pm.response.text()
        JS_SetPropertyStr (ctx, response, "text",
        JS_NewCFunction (ctx, js_response_text, "text", 0));

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

        // pm.response.to.have chain for Postman-compatible assertions
        JS_SetPropertyStr (ctx, response, "to", create_response_to_object (ctx));
    }

    JS_SetPropertyStr (ctx, pm, "response", response);
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
        // pm.request.url
        JS_SetPropertyStr (
        ctx, request, "url", JS_NewString (ctx, data->request->url.c_str ()));

        // pm.request.method
        JS_SetPropertyStr (ctx, request, "method",
        JS_NewString (ctx, to_string (data->request->method)));

        // pm.request.headers - the object the write-back reads, so its methods
        // and plain assignment reach the same property set.
        JSValue headers = JS_NewObject (ctx);
        install_header_methods (ctx, headers, /*mutators=*/true);
        for (const auto& [key, value] : data->request->headers) {
            define_header_entry (ctx, headers, key, value);
        }
        JS_SetPropertyStr (ctx, request, "headers", headers);

        // pm.request.body
        if (data->request->body.mode != BodyMode::None) {
            JS_SetPropertyStr (ctx, request, "body",
            JS_NewString (ctx, data->request->body.content.c_str ()));
        }
    }

    JS_SetPropertyStr (ctx, pm, "request", request);
}

// ============================================================================
// pm.request write-back (pre-request scripts)
// ============================================================================

// Frees a borrowed JSValue on every exit. The write-back below reads a dozen
// properties and refuses on most of them, and QuickJS ships no such helper.
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

// Read the header object the script left behind into `out`.
// @return why the headers were rejected, or nullopt when `out` is filled.
std::optional<std::string>
read_pm_request_headers (JSContext* ctx, JSValueConst js_headers, Headers& out) {
    if (!JS_IsObject (js_headers) || QJS_IsArray (ctx, js_headers) ||
    JS_IsFunction (ctx, js_headers)) {
        return "pm.request.headers must be an object, got " +
        std::string (js_type_name (ctx, js_headers));
    }

    JSPropertyEnum* props = nullptr;
    uint32_t count        = 0;
    if (JS_GetOwnPropertyNames (ctx, &props, &count, js_headers,
        JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
        return std::string ("pm.request.headers could not be enumerated");
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
            error = "pm.request.headers has an empty header name";
        } else if (JS_IsString (value.get ()) || JS_IsNumber (value.get ()) ||
        JS_IsBool (value.get ())) {
            // JS object keys are case-sensitive; HTTP header names are not. So
            // `Authorization` and `authorization` are two properties over there
            // and one header over here, and whichever enumerated last would
            // silently win. Which one the script meant is unknowable, and one
            // of them is an Authorization header - refuse instead of guessing.
            if (auto clash = out.find (key); clash != out.end () && clash->first != key) {
                error = "pm.request.headers has both '" + clash->first + "' and '" + key +
                "' - HTTP header names are case-insensitive, so these are one "
                "header. "
                "Keep one.";
            } else {
                out[key] = js_to_string (ctx, value.get ());
            }
        } else {
            error = "pm.request.headers['" + key + "'] must be a string, got " +
            std::string (js_type_name (ctx, value.get ())) +
            " (use delete pm.request.headers['" + key + "'] to remove it)";
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

    ScopedValue js_url (ctx, JS_GetPropertyStr (ctx, js_request.get (), "url"));
    if (!JS_IsString (js_url.get ())) {
        return "pm.request.url must be a string, got " +
        std::string (js_type_name (ctx, js_url.get ()));
    }
    staged.url = js_to_string (ctx, js_url.get ());
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
    if (auto reason = read_pm_request_headers (ctx, js_headers.get (), staged.headers)) {
        return reason;
    }

    ScopedValue js_body (ctx, JS_GetPropertyStr (ctx, js_request.get (), "body"));
    if (JS_IsUndefined (js_body.get ()) || JS_IsNull (js_body.get ())) {
        staged.body = Body{};
    } else if (JS_IsString (js_body.get ())) {
        staged.body.content = js_to_string (ctx, js_body.get ());
        if (staged.body.mode == BodyMode::None) {
            // A body on a request that had none: Text is the mode that means
            // "this string, as written". Nothing downstream derives
            // Content-Type from the mode, so the script still owns that header.
            staged.body.mode = BodyMode::Text;
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

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_UNDEFINED;
    }

    auto it = variables->find (js_to_string (ctx, argv[0]));
    if (it != variables->end () && it->second.enabled) {
        return cast_variable_to_jsvalue (ctx, it->second);
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

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_NewBool (ctx, 0);
    }

    auto it = variables->find (js_to_string (ctx, argv[0]));
    return JS_NewBool (ctx, it != variables->end () && it->second.enabled ? 1 : 0);
}

// The method with no workaround: setting a variable to "" leaves an enabled
// empty variable behind, which is not the same thing to `{{template}}`
// resolution as the variable being gone. The removal reaches disk through
// persist_script_variables, which rewrites a scope whenever the map it ends
// with differs from the one on disk.
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

    if (Environment* variables = scope_variables (ctx, magic)) {
        for (const auto& [key, variable] : *variables) {
            if (variable.enabled) {
                JS_SetPropertyStr (ctx, snapshot, key.c_str (),
                cast_variable_to_jsvalue (ctx, variable));
            }
        }
    }

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
        Environment* variables = scope_variables (ctx, scope);
        if (!variables) {
            continue;
        }
        auto it = variables->find (key);
        if (it != variables->end () && it->second.enabled) {
            return cast_variable_to_jsvalue (ctx, it->second);
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
        Environment* variables = scope_variables (ctx, scope);
        if (!variables) {
            continue;
        }
        auto it = variables->find (key);
        if (it != variables->end () && it->second.enabled) {
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
        Environment* variables = scope_variables (ctx, *it);
        if (!variables) {
            continue;
        }
        for (const auto& [key, variable] : *variables) {
            if (variable.enabled) {
                JS_SetPropertyStr (ctx, snapshot, key.c_str (),
                cast_variable_to_jsvalue (ctx, variable));
            }
        }
    }

    return snapshot;
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
    JS_SetPropertyStr (
    ctx, variables, "set", JS_NewCFunction (ctx, js_pm_variables_set, "set", 2));

    JS_SetPropertyStr (ctx, pm, "variables", variables);
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

    // pm.test()
    JS_SetPropertyStr (ctx, pm, "test", JS_NewCFunction (ctx, js_pm_test, "test", 2));

    // pm.expect()
    JS_SetPropertyStr (ctx, pm, "expect", JS_NewCFunction (ctx, js_pm_expect, "expect", 1));

    // pm.response
    setup_pm_response (ctx, pm);

    // pm.request
    setup_pm_request (ctx, pm);

    // pm.environment, pm.globals, pm.collectionVariables
    for (const auto& binding : variable_scope_bindings) {
        setup_pm_variable_scope (ctx, pm, binding);
    }

    // pm.variables
    setup_pm_variables (ctx, pm);

    JS_SetPropertyStr (ctx, global, "pm", pm);
    JS_FreeValue (ctx, global);
}

} // anonymous namespace

// ============================================================================
// ScriptEngine Implementation
// ============================================================================

// Per-runtime deadline state for the interrupt handler. One instance is owned by
// each pooled JSRuntime (stored as its runtime opaque) and refreshed before every
// execution. QuickJS runtimes are single-threaded, and each pooled context pair is
// used by one thread at a time, so no synchronization is needed here.
struct RuntimeState {
    bool enabled = false; // false => no wall-clock limit (timeout_ms == 0)
    std::chrono::steady_clock::time_point deadline{};
};

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
            auto* rt_state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (pair.first));
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
            QJS_NewClassID (rt, &expect_class_id);
        }
        JS_NewClass (rt, expect_class_id, &expect_class);

        // Register the pm.response.to.* chain class, whose exotic hook makes an
        // unknown assertion throw instead of silently evaluating to undefined.
        if (response_chain_class_id == 0) {
            QJS_NewClassID (rt, &response_chain_class_id);
        }
        JS_NewClass (rt, response_chain_class_id, &response_chain_class);

        JSContext* ctx = JS_NewContext (rt);
        if (ctx) {
            if (config.enable_console) {
                setup_console (ctx);
            }
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
        JS_SetContextOpaque (js_ctx, &ctx_data);

        // Refresh pm.request and pm.response with new data
        JSValue global = JS_GetGlobalObject (js_ctx);
        JSValue pm     = JS_GetPropertyStr (js_ctx, global, "pm");
        if (!JS_IsUndefined (pm)) {
            setup_pm_response (js_ctx, pm);
            setup_pm_request (js_ctx, pm);
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
    ScriptContext ctx;
    ctx.make_request_mutable (request);
    ctx.environment = &env;
    return execute (script, ctx);
}

ScriptResult ScriptEngine::execute_test (const std::string& script,
const Request& request,
const Response& response,
Environment& env) {
    ScriptContext ctx;
    ctx.request     = &request;
    ctx.response    = &response;
    ctx.environment = &env;
    return execute (script, ctx);
}

bool ScriptEngine::is_available () {
    return true;
}

std::string ScriptEngine::version () {
    return "QuickJS 2024-01-13";
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

// NOLINTEND
