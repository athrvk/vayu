/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_expect.cpp
 * @brief `pm.test` and the `pm.expect` chainable assertions.
 */

#include "pm_internal.hpp"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

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
    // Whether the unknown-member hook is live. `create_expectation` installs
    // every member first and sets this last, because defining a property looks
    // up the existing own property, so a hook armed from the moment the object
    // existed would reject the chain's own members as they are installed.
    bool armed = false;
};

// Names the engine itself probes on an arbitrary value. Answering "no own
// property" for them keeps JSON.stringify and promise resolution working;
// reporting them as misspelled assertions would make console.log of an
// assertion object throw. They are not on Object.prototype, so the prototype
// check below does not cover them.
constexpr const char* chain_passthrough_members[] = { "toJSON", "then" };

} // namespace

/**
 * @brief The body every assertion chain's unknown-member hook shares.
 *
 * A name the object does not implement is a misspelled or unimplemented
 * assertion and throws naming @p path; the plumbing a JS runtime probes on an
 * arbitrary value goes on resolving. Answers QuickJS's `get_own_property`
 * convention: 0 to continue the normal lookup, -1 with a pending exception.
 *
 * One copy for both chains rather than two: `pm.response.to` and
 * `pm.expect(...)` differ only in how each says it is armed and in the path it
 * names, and a second copy of the passthrough rules would be the one that
 * misses the next fix.
 */
int report_unknown_chain_member (JSContext* ctx, JSValueConst obj, JSAtom prop, const char* path) {
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

    for (const char* passthrough : chain_passthrough_members) {
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

JSClassID expect_class_id = 0;

namespace {

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

/**
 * @brief Turns an unrecognised member of an expectation into a throw.
 *
 * `pm.expect(x).to.be.NaN` is an expression statement, so a member nothing
 * implements evaluates to `undefined` and asserts nothing - the test reports
 * PASS whatever the value is, which for a matcher that was *meant* to check
 * something is the worst answer an assertion library can give. `pm.response.to`
 * has thrown by name since #487; this is the same rule for the other chain, and
 * it covers every matcher chai has and Vayu does not, present and future, plus
 * every typo.
 *
 * The state's `armed` flag is what keeps `create_expectation` able to install
 * the chain's own members: defining a property looks the existing one up first,
 * so a hook live from the moment the object existed would reject them.
 */
int expect_unknown_member (JSContext* ctx, JSPropertyDescriptor* desc, JSValueConst obj, JSAtom prop) {
    (void)desc;
    const auto* state =
    static_cast<const ExpectState*> (JS_GetOpaque (obj, expect_class_id));
    if (!state || !state->armed) {
        return 0;
    }
    return report_unknown_chain_member (ctx, obj, prop, "pm.expect(...)");
}

// Value-initialized and then assigned rather than written as a designated
// initializer, for the reason spelled out at `response_chain_exotic` in
// pm_response.cpp: naming one of the struct's seven hooks leaves the other six
// as -Wmissing-field-initializers warnings.
JSClassExoticMethods expect_exotic = [] {
    JSClassExoticMethods exotic{};
    exotic.get_own_property = expect_unknown_member;
    return exotic;
}();

} // namespace

JSClassDef expect_class = { .class_name = "Expectation",
    .finalizer                          = expect_finalizer,
    .gc_mark                            = expect_gc_mark,
    .call                               = nullptr,
    .exotic                             = &expect_exotic };

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

namespace {

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

} // namespace

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

namespace {

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

} // namespace

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
int js_deep_equal (JSContext* ctx, JSValueConst a, JSValueConst b, int depth, DeepEqualPath& path, ZeroRule zeros) {
    if (depth > kDeepEqualMaxDepth) {
        JS_ThrowRangeError (ctx,
        "deep equality gave up after %d levels - the compared values are "
        "cyclic "
        "or too deeply nested",
        kDeepEqualMaxDepth);
        return -1;
    }

    if (js_strict_equal (ctx, a, b)) {
        // `+0 === -0`, so strict equality does not settle a signed-zero pair for
        // a caller reading deep-eql's rule.
        if (zeros == ZeroRule::SameValueZero || !JS_IsNumber (a)) {
            return 1;
        }
        double lhs = 0, rhs = 0;
        JS_ToFloat64 (ctx, &lhs, a);
        JS_ToFloat64 (ctx, &rhs, b);
        if (lhs != 0) {
            return 1;
        }
        return std::signbit (lhs) == std::signbit (rhs) ? 1 : 0;
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
    // Both branches below render each side through script the test author may
    // have written - an own `toJSON`, an overridden `toString` - and both
    // renderers answer "" when that throws, leaving the exception pending. Two
    // empty renderings compare *equal*, so a pair of throwing Dates used to
    // report a pass. Neither renderer reports failure, so the context is asked
    // instead - and asked after each side, because `JS_Throw` replaces the
    // pending exception, so rendering the second side over a first that threw
    // would report b's error for a's read.
    if (tag == "[object Date]") {
        // JSON renders a Date as its ISO instant, which is the comparison chai
        // makes (and keeps millisecond resolution, unlike toString).
        const std::string a_json = js_to_json (ctx, a);
        if (JS_HasException (ctx)) {
            return -1;
        }
        const std::string b_json = js_to_json (ctx, b);
        if (JS_HasException (ctx)) {
            return -1;
        }
        return a_json == b_json ? 1 : 0;
    }
    if (tag == "[object RegExp]") {
        const std::string a_source = js_to_string (ctx, a);
        if (JS_HasException (ctx)) {
            return -1;
        }
        const std::string b_source = js_to_string (ctx, b);
        if (JS_HasException (ctx)) {
            return -1;
        }
        return a_source == b_source ? 1 : 0;
    }
    if (tag != "[object Object]" && tag != "[object Array]" && tag != "[object Error]") {
        // Map, Set, typed arrays and the like hold their contents somewhere a
        // structural compare cannot see, so every pair would look equal. Report
        // unequal rather than pass silently; reference identity already matched
        // the only case that is certainly equal.
        return 0;
    }

    // Every read below can run script: a getter the author wrote, or a Proxy
    // trap - `IsArray` unwraps a proxy, so a proxy of an array reaches this
    // branch and even its `length` goes through a trap. A read that throws
    // leaves the exception pending and hands back the exception sentinel, which
    // is neither a number nor an object, so comparing it reports an ordinary
    // "not deeply equal" about a read that never happened - #959's shape, one
    // level down. Each pair stops at the *first* side that throws, because
    // reading the second would run more script and could replace the error the
    // script author is owed.
    if (tag == "[object Array]") {
        ScopedValue a_len_val (ctx, JS_GetPropertyStr (ctx, a, "length"));
        if (JS_IsException (a_len_val.get ())) {
            return -1;
        }
        ScopedValue b_len_val (ctx, JS_GetPropertyStr (ctx, b, "length"));
        if (JS_IsException (b_len_val.get ())) {
            return -1;
        }
        uint32_t a_len = 0, b_len = 0;
        if (JS_ToUint32 (ctx, &a_len, a_len_val.get ()) < 0 ||
        JS_ToUint32 (ctx, &b_len, b_len_val.get ()) < 0) {
            return -1;
        }
        if (a_len != b_len) {
            return 0;
        }
        for (uint32_t i = 0; i < a_len; i++) {
            ScopedValue a_elem (ctx, JS_GetPropertyUint32 (ctx, a, i));
            if (JS_IsException (a_elem.get ())) {
                return -1;
            }
            ScopedValue b_elem (ctx, JS_GetPropertyUint32 (ctx, b, i));
            if (JS_IsException (b_elem.get ())) {
                return -1;
            }
            path.emplace_back (a_id, b_id);
            const int same =
            js_deep_equal (ctx, a_elem.get (), b_elem.get (), depth + 1, path, zeros);
            path.pop_back ();
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
        // Same rule as the array branch above: a key backed by a throwing
        // getter is a read that did not happen, not a mismatch.
        ScopedValue a_val (ctx, JS_GetPropertyStr (ctx, a, key.c_str ()));
        if (JS_IsException (a_val.get ())) {
            return -1;
        }
        ScopedValue b_val (ctx, JS_GetPropertyStr (ctx, b, key.c_str ()));
        if (JS_IsException (b_val.get ())) {
            return -1;
        }
        path.emplace_back (a_id, b_id);
        const int same =
        js_deep_equal (ctx, a_val.get (), b_val.get (), depth + 1, path, zeros);
        path.pop_back ();
        if (same != 1) {
            return same;
        }
    }
    return 1;
}

namespace {

// Compares by whichever rule the chain asked for: `deep` when a `deep` /
// `eql` chain set it, strict otherwise. -1 signals a pending exception.
int js_compare_for_chain (JSContext* ctx, JSValueConst a, JSValueConst b, bool deep) {
    if (!deep) {
        return js_strict_equal (ctx, a, b) ? 1 : 0;
    }
    DeepEqualPath path;
    return js_deep_equal (ctx, a, b, 0, path, ZeroRule::Signed);
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

/**
 * @brief `.to.be.true` / `.to.be.false`: the boolean itself, not its truthiness.
 *
 * chai compares with `=== true` and `=== false`, so `expect(1).to.be.true` and
 * `expect("").to.be.false` fail there. Reading them through `JS_ToBool` passed
 * both, and `.not.be.false` on `null` as well. `.ok` is the truthy matcher and
 * keeps `JS_ToBool` (#2523).
 */
JSValue expect_boolean_literal (JSContext* ctx, JSValueConst this_val, bool expected) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const bool is_literal = JS_IsBool (state->actual) &&
    (JS_ToBool (ctx, state->actual) == 1) == expected;
    const bool pass = state->negated ? !is_literal : is_literal;

    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be " : " to be ") + (expected ? "true" : "false");
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue expect_true (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    return expect_boolean_literal (ctx, this_val, true);
}

JSValue expect_false (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    return expect_boolean_literal (ctx, this_val, false);
}

/**
 * @brief The value an ordering matcher compares, or nothing.
 *
 * chai orders numbers and Dates, and **type-asserts both sides** rather than
 * coercing: `expect("5").to.be.above(3)` is an error there, not a pass. Vayu
 * ran both sides through `ToNumber`, which reads "5" as 5, `true` as 1, `[5]`
 * as 5 and `null` as 0 - so a comparison the script never meant returned a
 * verdict, in whichever direction the coercion happened to fall.
 *
 * A Date is read as its instant, which is what `ToNumber` on one answers. The
 * kind comes back with the value because chai compares a number with a number
 * and a Date with a Date, and refuses the mixed pair rather than reading the
 * Date as milliseconds.
 *
 * @p failed is set when *reading* the value raised, and the exception is left
 * pending for the caller. That is #959's rule, written 400 lines above for the
 * deep compare: a value that could not be read must not be reported as "not a
 * number", because the two are different answers and only one of them is true.
 */
enum class OrderingKind { NotOrderable, Number, Date };

struct OrderingValue {
    OrderingKind kind = OrderingKind::NotOrderable;
    double value      = 0;
};

const char* ordering_kind_name (OrderingKind kind) {
    return kind == OrderingKind::Date ? "a Date" : "a number";
}

OrderingValue js_ordering_value (JSContext* ctx, JSValueConst value, bool& failed) {
    OrderingKind kind = OrderingKind::NotOrderable;
    if (JS_IsNumber (value)) {
        kind = OrderingKind::Number;
    } else if (JS_IsObject (value)) {
        bool tag_failed       = false;
        const std::string tag = js_class_tag (ctx, value, &tag_failed);
        if (tag_failed) {
            failed = true;
            return {};
        }
        if (tag == "[object Date]") {
            kind = OrderingKind::Date;
        }
    }
    if (kind == OrderingKind::NotOrderable) {
        return {};
    }

    OrderingValue out{ kind, 0 };
    if (JS_ToFloat64 (ctx, &out.value, value) < 0) {
        failed = true;
        return {};
    }
    return out;
}

// The four ordering matchers differ in one comparison and one word, so they are
// one function reached by magic rather than four copies - the type assertion
// above is the same rule in all four, and a fourth copy of it is the one a later
// fix would miss.
struct OrderingMatcher {
    const char* name;
    const char* relation;
};
constexpr OrderingMatcher ordering_matchers[] = { { "above", "above" },
    { "below", "below" }, { "least", "at least" }, { "most", "at most" } };

// The magic a matcher is registered with is its index in that table, and this
// switch reads the same index. A fifth entry appended to the table would run as
// `at.most` through the default arm and read past the table in the lookup, so
// the count is asserted here rather than trusted: an ordering matcher that
// silently answered the wrong comparison is the failure this file exists to
// stop.
static_assert (std::size (ordering_matchers) == 4,
"add an arm to ordering_holds and a case below before growing this table");

bool ordering_holds (size_t which, double actual, double expected) {
    switch (which) {
    case 0: return actual > expected;
    case 1: return actual < expected;
    case 2: return actual >= expected;
    case 3: return actual <= expected;
    default: return false;
    }
}

JSValue
expect_ordering (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    const auto& matcher = ordering_matchers[static_cast<size_t> (magic)];
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "%s() requires an argument", matcher.name);
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool failed                = false;
    const OrderingValue actual = js_ordering_value (ctx, state->actual, failed);
    const OrderingValue expected =
    failed ? OrderingValue{} : js_ordering_value (ctx, argv[0], failed);
    if (failed) {
        return JS_EXCEPTION;
    }
    if (actual.kind == OrderingKind::NotOrderable) {
        return JS_ThrowTypeError (ctx, "%s() expects the target to be a number or a Date, got %s",
        matcher.name, js_type_name (ctx, state->actual));
    }
    if (expected.kind == OrderingKind::NotOrderable) {
        return JS_ThrowTypeError (ctx, "%s() expects a number or a Date, got %s",
        matcher.name, js_type_name (ctx, argv[0]));
    }
    // chai orders like with like: a Date read as milliseconds against a number
    // is a comparison neither side asked for, so the mixed pair is refused
    // rather than answered.
    if (actual.kind != expected.kind) {
        return JS_ThrowTypeError (ctx,
        "%s() compares a number with a number and a Date with a "
        "Date, got %s and %s",
        matcher.name, ordering_kind_name (actual.kind),
        ordering_kind_name (expected.kind));
    }

    const bool holds =
    ordering_holds (static_cast<size_t> (magic), actual.value, expected.value);
    const bool pass = state->negated ? !holds : holds;

    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be " : " to be ") + matcher.relation + " " +
        js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

/**
 * @brief chai's `.include` against an object target: subset matching.
 *
 * Every own enumerable key of @p expected must be present on @p target holding
 * an equal value, by the chain's comparison rule - `include` is strict per key,
 * `deep.include` deep. Answers 1, 0, or -1 with a pending exception.
 *
 * A target that is not an object holds no key, so it matches nothing. That is
 * the verdict chai reaches for the same pair by a longer route (it runs a
 * property assertion per key against the primitive), and it keeps this helper
 * out of `JS_HasProperty` on a value that is not an object.
 *
 * The caller has already refused an expectation with no keys, so "every key
 * matched" is never vacuous here.
 */
int expect_object_subset (JSContext* ctx, JSValueConst target, JSValueConst expected, bool deep) {
    std::vector<std::string> keys;
    if (!js_own_enumerable_keys (ctx, expected, keys)) {
        return -1;
    }
    if (!JS_IsObject (target)) {
        return 0;
    }

    for (const auto& key : keys) {
        JSAtom atom       = JS_NewAtom (ctx, key.c_str ());
        const int present = JS_HasProperty (ctx, target, atom);
        JS_FreeAtom (ctx, atom);
        if (present < 0) {
            return -1;
        }
        if (present == 0) {
            return 0;
        }

        // A getter that throws is not a mismatch, it is a read that did not
        // happen: the exception is left pending and reported, rather than
        // answered as "these differ" - which under `.not` would have been a
        // pass. Same rule the deep compare states for a class tag it could not
        // read (#959).
        ScopedValue held (ctx, JS_GetPropertyStr (ctx, target, key.c_str ()));
        if (JS_IsException (held.get ())) {
            return -1;
        }
        ScopedValue wanted (ctx, JS_GetPropertyStr (ctx, expected, key.c_str ()));
        if (JS_IsException (wanted.get ())) {
            return -1;
        }
        const int same = js_compare_for_chain (ctx, held.get (), wanted.get (), deep);
        if (same != 1) {
            return same;
        }
    }
    return 1;
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

    // A Url or RequestBody object takes the substring branch, not the "neither
    // string nor array" one that answers false: both replaced a string on
    // `pm.request` (#991, #1003) and both are documented as still reading as
    // one. See `expect_string_like`.
    if (auto text = expect_string_like (ctx, state->actual)) {
        const std::string substr = js_to_string (ctx, argv[0]);
        includes                 = text->find (substr) != std::string::npos;
    } else if (JS_IsArray (state->actual)) {
        JSValue length = JS_GetPropertyStr (ctx, state->actual, "length");
        uint32_t len;
        JS_ToUint32 (ctx, &len, length);
        JS_FreeValue (ctx, length);

        // Membership follows the chain's comparison rule. It used to compare
        // `JS_ToCString` forms, under which every object member matched every
        // object needle - both render as "[object Object]".
        for (uint32_t i = 0; i < len && !includes; i++) {
            // The reads a comparison is given are the comparison's own: an
            // element behind a getter that throws is a read that did not
            // happen. Handing the exception sentinel to `js_compare_for_chain`
            // answers "not a member" about it, and under `.not` that is a pass.
            // Same rule the deep compare states for its own reads.
            ScopedValue elem (ctx, JS_GetPropertyUint32 (ctx, state->actual, i));
            if (JS_IsException (elem.get ())) {
                return JS_EXCEPTION;
            }
            const int same =
            js_compare_for_chain (ctx, elem.get (), argv[0], state->deep);
            if (same < 0) {
                return JS_EXCEPTION;
            }
            includes = (same == 1);
        }
    } else if (JS_IsObject (argv[0])) {
        // chai's `.include` on anything that is not a string, an array or one of
        // the containers it inspects is subset matching. This branch answered
        // false for every object pair, so `.include({...})` always failed and
        // `.not.include({...})` always passed - a verdict, silently, whatever
        // the target held.
        //
        // An expectation with no own enumerable keys is refused rather than
        // matched. chai walks its keys and, finding none, asserts nothing and
        // passes in *both* directions; a computed subset that came out empty is
        // then a green test that compared nothing, which is the defect this
        // whole change exists to remove. A Date, a RegExp and a function all
        // land here, and each of them reads as an assertion while carrying no
        // key to check.
        std::vector<std::string> keys;
        if (!js_own_enumerable_keys (ctx, argv[0], keys)) {
            return JS_EXCEPTION;
        }
        if (keys.empty ()) {
            return JS_ThrowTypeError (ctx,
            "include() was given %s with no properties to match, "
            "which would assert nothing",
            js_describe (ctx, argv[0]).c_str ());
        }

        const int same =
        expect_object_subset (ctx, state->actual, argv[0], state->deep);
        if (same < 0) {
            return JS_EXCEPTION;
        }
        includes = (same == 1);
    } else {
        // chai refuses this combination rather than answering it, and so does
        // this: `expect(5).to.include("x")` asserted nothing here, which under
        // `.not` is a pass no script author asked for.
        return JS_ThrowTypeError (ctx,
        "include() expects an object argument when the target is %s, got %s",
        js_type_name (ctx, state->actual), js_type_name (ctx, argv[0]));
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
        // A segment behind a getter that throws is a walk that did not finish.
        // The sentinel is not an object, so the loop would call it a missing
        // property - and under `.not` that reads as a pass.
        if (JS_IsException (holder)) {
            return JS_EXCEPTION;
        }
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
        // `JS_HasProperty` above does not run the getter, so this is the first
        // read of the value - and the one the comparison is given.
        ScopedValue actual_val (
        ctx, JS_GetPropertyStr (ctx, holder, segments.back ().c_str ()));
        if (JS_IsException (actual_val.get ())) {
            JS_FreeValue (ctx, holder);
            return JS_EXCEPTION;
        }
        const int same =
        js_compare_for_chain (ctx, actual_val.get (), argv[1], state->deep);
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
        // The key list is what "empty" means for an object, and a proxy's
        // ownKeys trap can refuse to produce it. Reporting "not empty" for a
        // list that was never produced is a pass under `.not`.
        if (JS_GetOwnPropertyNames (ctx, &tab, &count, state->actual,
            JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
            return JS_EXCEPTION;
        }
        is_empty = (count == 0);
        for (uint32_t i = 0; i < count; i++) {
            JS_FreeAtom (ctx, tab[i].atom);
        }
        js_free (ctx, tab);
    }

    bool pass = state->negated ? !is_empty : is_empty;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not be empty" :
                                           "Expected value to be empty";
        return throw_expect_failure (ctx, state, msg);
    }

    return JS_DupValue (ctx, this_val);
}

/**
 * `.NaN` - chai's rule is `value !== value`, which only a NaN number satisfies.
 *
 * Deliberately not `ToNumber(value)` is NaN: chai reports `expect("foo").to.be
 * .NaN` as a failure, and a matcher that coerced would pass for every string
 * that is not a number. It is a getter rather than a call because chai's is one,
 * which is exactly why its absence was silent - `.to.be.NaN` on an object with
 * no such member is an expression statement evaluating to `undefined`.
 */
JSValue expect_nan_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double value      = 0;
    const bool is_nan = JS_IsNumber (state->actual) &&
    JS_ToFloat64 (ctx, &value, state->actual) >= 0 && std::isnan (value);
    const bool pass = state->negated ? !is_nan : is_nan;

    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be NaN" : " to be NaN");
        return throw_expect_failure (ctx, state, msg);
    }

    return JS_DupValue (ctx, this_val);
}

// Callable matchers documented in pm-api-compatibility.md but previously absent.
// `least` and `most` are the other two arms of `expect_ordering` above.

JSValue expect_length (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "length() requires an argument");
    }

    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    ScopedValue length_val (ctx, JS_GetPropertyStr (ctx, state->actual, "length"));
    // A `length` the read could not produce is neither absent nor a number:
    // the script's own error is the answer, not "requires a value with a
    // length" and not a comparison against an uninitialised double.
    if (JS_IsException (length_val.get ())) {
        return JS_EXCEPTION;
    }
    if (JS_IsUndefined (length_val.get ())) {
        return JS_ThrowTypeError (ctx, "length() requires a value with a length");
    }

    double actual_len = 0, expected = 0;
    if (JS_ToFloat64 (ctx, &actual_len, length_val.get ()) < 0) {
        return JS_EXCEPTION;
    }
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

    const std::string expected = vayu::utils::ascii_lower (js_to_string (ctx, argv[0]));

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
        // Same rule as `include`: a candidate that could not be read is not a
        // candidate the target failed to match.
        ScopedValue candidate (ctx, JS_GetPropertyUint32 (ctx, argv[0], i));
        if (JS_IsException (candidate.get ())) {
            return JS_EXCEPTION;
        }
        const int same =
        js_compare_for_chain (ctx, state->actual, candidate.get (), state->deep);
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
            // A name that could not be read is not a name: `js_to_string`
            // answers "" for it, and an empty key would be compared against
            // the target's real ones as though the script had asked for it.
            ScopedValue key (ctx, JS_GetPropertyUint32 (ctx, argv[0], i));
            if (JS_IsException (key.get ())) {
                return JS_EXCEPTION;
            }
            expected.push_back (js_to_string (ctx, key.get ()));
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
        // Same rule as `include`: an element that could not be read is not an
        // element that failed to pair.
        ScopedValue wanted (ctx, JS_GetPropertyUint32 (ctx, argv[0], i));
        if (JS_IsException (wanted.get ())) {
            return JS_EXCEPTION;
        }
        bool paired = false;
        for (uint32_t j = 0; j < actual_len && !paired; j++) {
            if (claimed[j]) {
                continue;
            }
            ScopedValue candidate (ctx, JS_GetPropertyUint32 (ctx, state->actual, j));
            if (JS_IsException (candidate.get ())) {
                return JS_EXCEPTION;
            }
            const int same =
            js_compare_for_chain (ctx, candidate.get (), wanted.get (), state->deep);
            if (same < 0) {
                return JS_EXCEPTION;
            }
            if (same == 1) {
                claimed[j] = true;
                paired     = true;
            }
        }
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

// What chai matches a string or a regular expression against: an `Error`'s
// `message`, and the thrown value itself for a script that threw something that
// is not one. `String(err)` - what this used to compare - is "TypeError: bad
// input", name included, so `.to.throw("Error")` passed for every Error thrown
// whatever it said, and `.to.throw("TypeError")` passed on a message that
// merely mentioned the word.
std::string thrown_message (JSContext* ctx, JSValueConst error) {
    if (JS_IsObject (error)) {
        ScopedValue message (ctx, JS_GetPropertyStr (ctx, error, "message"));
        if (JS_IsString (message.get ())) {
            return js_to_string (ctx, message.get ());
        }
    }
    // A thrown string is its own message and anything else has none, which is
    // chai's `check-error.getMessage`. Stringifying the rest instead would make
    // `.to.throw("4")` pass on `throw 42`.
    if (JS_IsString (error)) {
        return js_to_string (ctx, error);
    }
    return {};
}

// A function's `name`, for a message that has to say which constructor it was
// given. One definition rather than two: `instanceOf` reads it the same way.
std::string js_function_name (JSContext* ctx, JSValueConst fn) {
    ScopedValue name (ctx, JS_GetPropertyStr (ctx, fn, "name"));
    return js_to_string (ctx, name.get ());
}

// Whether a thrown message satisfies chai's message matcher - a substring or a
// regular expression. 1 matched, 0 not, -1 with a pending exception.
int matches_thrown_message (JSContext* ctx, JSValueConst matcher, const std::string& message) {
    if (JS_IsString (matcher)) {
        return message.find (js_to_string (ctx, matcher)) != std::string::npos ? 1 : 0;
    }

    ScopedValue test_fn (ctx,
    JS_IsObject (matcher) ? JS_GetPropertyStr (ctx, matcher, "test") : JS_UNDEFINED);
    if (!JS_IsFunction (ctx, test_fn.get ())) {
        JS_ThrowTypeError (ctx,
        "throw() accepts an error constructor, a message "
        "substring or a regular expression");
        return -1;
    }

    ScopedValue subject (ctx, JS_NewString (ctx, message.c_str ()));
    JSValue subject_arg = subject.get ();
    ScopedValue tested (ctx, JS_Call (ctx, test_fn.get (), matcher, 1, &subject_arg));
    if (JS_IsException (tested.get ())) {
        return -1;
    }
    return JS_ToBool (ctx, tested.get ()) == 1 ? 1 : 0;
}

JSValue expect_throw (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*> (JS_GetOpaque (this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsFunction (ctx, state->actual)) {
        return JS_ThrowTypeError (ctx, "throw() requires the target to be a function");
    }

    arm_script_deadline_watch (ctx);
    JSValue result   = JS_Call (ctx, state->actual, JS_UNDEFINED, 0, nullptr);
    const bool threw = JS_IsException (result);
    JS_FreeValue (ctx, result);
    // A target that ran past the script's deadline did not throw - the engine
    // stopped it, and the exception it left pending is the abort. Propagate it
    // as every other surface does; reading it as a satisfied `.throw()` reports
    // a green verdict about a function that never returned.
    if (threw && script_deadline_expired (ctx)) {
        return JS_EXCEPTION;
    }
    ScopedValue thrown (ctx, threw ? JS_GetException (ctx) : JS_UNDEFINED);
    const std::string message =
    threw ? thrown_message (ctx, thrown.get ()) : std::string ();

    bool matches      = threw;
    int matcher_index = 0;
    // chai reads a function argument as the error constructor the throw must be
    // an instance of, and takes an optional message matcher after it. Vayu
    // refused a constructor outright ("accepts a message substring or a regular
    // expression"), so `expect(fn).to.throw(TypeError)` - ordinary chai, and
    // what imported scripts carry - was an error rather than an assertion.
    if (threw && argc >= 1 && JS_IsFunction (ctx, argv[0])) {
        const int is_instance = JS_IsInstanceOf (ctx, thrown.get (), argv[0]);
        if (is_instance < 0) {
            return JS_EXCEPTION;
        }
        matches       = (is_instance == 1);
        matcher_index = 1;
    }

    // The message matcher, whether it is the only argument or the one after a
    // constructor. A second argument is read rather than dropped: a script that
    // states the message means it to be checked.
    if (matches && argc > matcher_index && !JS_IsUndefined (argv[matcher_index])) {
        const int matched = matches_thrown_message (ctx, argv[matcher_index], message);
        if (matched < 0) {
            return JS_EXCEPTION;
        }
        matches = (matched == 1);
    }

    const bool pass = state->negated ? !matches : matches;
    if (!pass) {
        // The message names what was expected, because with an argument the
        // bare form contradicts itself: "expected the function to throw, but it
        // threw RangeError: bad" reads as an engine fault when what failed was
        // the constructor the script named.
        std::string msg = state->negated ?
        "Expected the function to not throw" :
        "Expected the function to throw";
        if (matcher_index == 1) {
            msg += " " + js_function_name (ctx, argv[0]);
        }
        if (argc > matcher_index && !JS_IsUndefined (argv[matcher_index])) {
            msg += " with a message matching " + js_describe (ctx, argv[matcher_index]);
        }
        msg += threw ? ", but it threw " + js_to_string (ctx, thrown.get ()) :
                       ", but it did not throw";
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
        const std::string ctor_name = js_function_name (ctx, argv[0]);
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
    //
    // The rest are chai's language chains (issue #1053): they assert nothing at
    // all and exist so a chain reads as English - `expect(rows).to.be.an
    // ('array').that.is.not.empty`. Without them an imported collection written
    // in the fluent style fails on the *language* rather than on the API under
    // test, since #999 armed the unknown-member hook and every one of these
    // words now throws by name. Each hands the same expectation back, so the
    // flags a chain has set - `not` included - carry across exactly as they do
    // for `and`.
    //
    // `.own` and `.itself` are deliberately not here and are not passthroughs:
    // they change what `.property` looks at rather than reading as prose, so
    // aliasing them would assert something other than what the script wrote.
    // `.own.property` is listed as unsupported in docs/app/pm-api-compatibility.md.
    const char* passthrough_chainers[] = { "and", "all", "also", "been", "but",
        "does", "has", "is", "of", "same", "still", "that", "which", "with" };
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
        { "true", expect_true }, { "false", expect_false }, { "null", expect_null_getter },
        { "undefined", expect_undefined_getter }, { "ok", expect_ok_getter },
        { "empty", expect_empty_getter }, { "NaN", expect_nan_getter } };
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
    int ordering_magic = 0;
    for (const auto& matcher : ordering_matchers) {
        JS_SetPropertyStr (ctx, obj, matcher.name,
        JS_NewCFunctionMagic (ctx, expect_ordering, matcher.name, 1,
        JS_CFUNC_generic_magic, ordering_magic));
        ordering_magic++;
    }
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

    // Last, once every member above is in place: from here a name this object
    // does not carry is a throw rather than `undefined`.
    state->armed = true;
    return obj;
}

// ============================================================================
// pm.test, pm.expect and pm.expect.fail
// ============================================================================

// The three fields a done-style test reports its outcome through. They live on
// a plain JS object rather than on a C++ struct on `js_pm_test`'s frame,
// because nothing stops a script from keeping `done` and calling it after
// `pm.test` has returned - the sandbox has no job queue to *resume* such a
// script, but the call itself still runs. Bound to a stack pointer that is a
// use-after-free; bound to an object the collector owns it is a write nobody
// reads.
constexpr const char* DONE_CALLED  = "called";
constexpr const char* DONE_FAILED  = "failed";
constexpr const char* DONE_MESSAGE = "message";

/**
 * @brief The `done` a test callback that declares a parameter is handed.
 *
 * Mocha's contract, which postman-sandbox follows: no argument (or a falsy one)
 * completes the test, and any truthy argument fails it - an `Error` being the
 * documented shape, reported by the same `js_to_string` the throw path reports
 * a thrown one with, so the two spellings of "this test failed" read alike.
 *
 * A second call is refused rather than allowed to overwrite the first verdict:
 * called twice inside the callback it throws, and the throw fails the test
 * naming what happened, which is what Postman does with it.
 */
JSValue js_test_done (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValueConst state = func_data[0];

    JSValue called_before = JS_GetPropertyStr (ctx, state, DONE_CALLED);
    const bool already    = JS_ToBool (ctx, called_before) > 0;
    JS_FreeValue (ctx, called_before);
    if (already) {
        return JS_ThrowTypeError (ctx, "done() was already called for this test");
    }
    JS_SetPropertyStr (ctx, state, DONE_CALLED, JS_TRUE);

    if (argc >= 1 && JS_ToBool (ctx, argv[0]) > 0) {
        const std::string message = js_to_string (ctx, argv[0]);
        JS_SetPropertyStr (ctx, state, DONE_FAILED, JS_TRUE);
        JS_SetPropertyStr (ctx, state, DONE_MESSAGE, JS_NewString (ctx, message.c_str ()));
    }
    return JS_UNDEFINED;
}

/**
 * @brief Whether @p callback declares a parameter, so it wants a `done`.
 *
 * postman-sandbox reads `fn.length` for exactly this, and the two forms report
 * their verdict differently, so the arity is the question that has to be asked
 * before the call rather than inferred from what the call did.
 *
 * @return the declared arity, or -1 with a pending exception.
 */
int32_t callback_arity (JSContext* ctx, JSValueConst callback) {
    JSValue length = JS_GetPropertyStr (ctx, callback, "length");
    if (JS_IsException (length)) {
        return -1;
    }
    int32_t arity = 0;
    const int ok  = JS_ToInt32 (ctx, &arity, length);
    JS_FreeValue (ctx, length);
    if (ok < 0) {
        return -1;
    }
    return arity;
}

/**
 * @brief Record what a done-style callback left behind on @p state.
 *
 * Called only when the callback returned without throwing - a throw is already
 * the verdict, and a test that threw before reaching its `done()` is not also
 * an asynchronous-completion mistake.
 */
void apply_done_verdict (JSContext* ctx, JSValueConst state, TestResult& result) {
    JSValue called        = JS_GetPropertyStr (ctx, state, DONE_CALLED);
    const bool was_called = JS_ToBool (ctx, called) > 0;
    JS_FreeValue (ctx, called);

    if (!was_called) {
        // Postman genuinely waits here; this sandbox cannot. It is synchronous
        // and drains no job queue, so a `done()` the callback left for later
        // would never run and the test would be reported on a verdict nothing
        // ever gave. Saying so is the honest outcome - and a loud one, where
        // the same script used to fail with "undefined is not a function".
        result.passed = false;
        result.error_message =
        "done() was never called. The script sandbox is synchronous and has no "
        "job queue, so a test cannot complete asynchronously - call done() "
        "before the callback returns.";
        return;
    }

    JSValue failed      = JS_GetPropertyStr (ctx, state, DONE_FAILED);
    const bool did_fail = JS_ToBool (ctx, failed) > 0;
    JS_FreeValue (ctx, failed);
    if (!did_fail) {
        result.passed = true;
        return;
    }

    JSValue message      = JS_GetPropertyStr (ctx, state, DONE_MESSAGE);
    result.passed        = false;
    result.error_message = js_to_string (ctx, message);
    JS_FreeValue (ctx, message);
}

} // namespace

JSValue js_pm_test (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 2) {
        return JS_ThrowTypeError (ctx, "pm.test requires name and callback");
    }

    auto* data            = get_context_data (ctx);
    std::string test_name = js_to_string (ctx, argv[0]);

    const int32_t arity = callback_arity (ctx, argv[1]);
    if (arity < 0) {
        return JS_EXCEPTION;
    }

    TestResult result;
    result.name = test_name;

    // A callback that declares a parameter is asking for the done-style form,
    // and gets one. One that does not is called exactly as it always was.
    JSValue state = JS_UNDEFINED;
    JSValue done  = JS_UNDEFINED;
    if (arity > 0) {
        state = JS_NewObject (ctx);
        if (JS_IsException (state)) {
            return JS_EXCEPTION;
        }
        JS_SetPropertyStr (ctx, state, DONE_CALLED, JS_FALSE);
        JS_SetPropertyStr (ctx, state, DONE_FAILED, JS_FALSE);
        done = JS_NewCFunctionData (ctx, js_test_done, 1, 0, 1, &state);
        if (JS_IsException (done)) {
            JS_FreeValue (ctx, state);
            return JS_EXCEPTION;
        }
    }

    // Call the test function
    JSValue ret = JS_Call (
    ctx, argv[1], JS_UNDEFINED, arity > 0 ? 1 : 0, arity > 0 ? &done : nullptr);

    if (JS_IsException (ret)) {
        JSValue exc          = JS_GetException (ctx);
        result.passed        = false;
        result.error_message = js_to_string (ctx, exc);
        JS_FreeValue (ctx, exc);
    } else if (arity > 0) {
        apply_done_verdict (ctx, state, result);
    } else {
        result.passed = true;
    }

    JS_FreeValue (ctx, done);
    JS_FreeValue (ctx, state);
    JS_FreeValue (ctx, ret);
    data->tests.push_back (std::move (result));

    // Postman returns `pm` to make the call chainable ("make it chainable",
    // verbatim in pmapi-setup-runner), so `pm.test(...).test(...)` runs both.
    // The `pm` a chain continues on is the one the call was made on, which is
    // what `this` is for every documented spelling of it.
    return JS_DupValue (ctx, this_val);
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

/**
 * @brief chai's `expect.fail([message])` - fail here, with this message.
 *
 * It is the one way a script states a failure *as an assertion* rather than as
 * an error: inside `pm.test` both fail the test, and at script level both abort
 * - what differs is the shape the verdict carries, an `AssertionError` with
 * this message rather than the `TypeError` a misuse reports. Reached as a
 * property of the `pm.expect` function itself, which is how chai spells it.
 *
 * chai's four-argument form (`actual, expected, message, operator`) builds an
 * AssertionError carrying the two values it compared; this AssertionError has
 * nowhere to put them, so that form is refused by name. Reading `actual` as
 * the message instead - what a single-argument implementation would do with
 * `fail(a, b)` - reports the value as the failure text and is the silent-wrong
 * shape this program exists to close.
 */
JSValue js_pm_expect_fail (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc > 1) {
        return JS_ThrowTypeError (ctx,
        "pm.expect.fail takes an optional message; chai's fail(actual, "
        "expected, message, operator) form is not supported");
    }

    // chai's own default when nothing is said, so a bare `pm.expect.fail()`
    // reports what a reader of chai's docs expects to see.
    std::string message = "expect.fail()";
    if (argc == 1 && !JS_IsUndefined (argv[0]) && !JS_IsNull (argv[0])) {
        const char* str = JS_ToCString (ctx, argv[0]);
        if (!str) {
            return JS_EXCEPTION;
        }
        message = str;
        JS_FreeCString (ctx, str);
    }

    return throw_assertion_failure (ctx, message);
}

} // namespace vayu::runtime::pm_detail
