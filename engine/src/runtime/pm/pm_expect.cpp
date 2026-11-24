/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** `pm.test` and the `pm.expect` chainable assertions. */

#include "pm_internal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <format>
#include <iterator>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/schema_validation.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

// ============================================================================
// pm.expect() Chainable Assertions
// ============================================================================

// What `change` / `increase` / `decrease` measured, kept for the `.by` that may
// follow in the same chain.
enum class DeltaBehavior { Change, Increase, Decrease };

struct DeltaRecord {
    DeltaBehavior behavior = DeltaBehavior::Change;
    // How a failure names what was measured: `.prop`, or the value a measuring
    // function answered before the call.
    std::string subject{};
    double initial    = 0;
    double after      = 0;
    double real_delta = 0;
};

// Expectation state, held by the JS object.
struct ExpectState {
    JSValue actual;
    bool negated = false;
    // Set by the `deep` / `nested` chainers and read by the matcher that ends
    // the chain, so `to.deep.equal` and `to.have.nested.property` change what
    // the same matcher compares rather than needing matchers of their own.
    bool deep   = false;
    bool nested = false;
    // `.own`: `.property` and `.include({...})` look at own properties only
    // (`hasOwnProperty`), where they otherwise accept an inherited one.
    bool own = false;
    // Set by reading `include` / `contain` / `includes` / `contains`, which is
    // chai's `contains`: `.keys` and `.members` that follow accept a superset,
    // and `.oneOf` asks whether the target contains a candidate.
    bool contains = false;
    // `.any` before `.keys`; `.all` (the default) clears it.
    bool any_key = false;
    // `.ordered` before `.members`: position matters.
    bool ordered = false;
    // `.itself` before `.respondTo`: a function target is asked about its own
    // members rather than its `prototype`'s.
    bool itself = false;
    // Set by reading `.length` / `.lengthOf`, which is chai's `doLength`: the
    // ordering matchers then compare the target's length (a Map's or Set's
    // size) instead of the target.
    bool do_length = false;
    // chai's second argument to `expect(value, message)`, empty for one
    // argument, read only by `throw_expect_failure`. The `{}` keeps
    // `create_expectation`'s two-field aggregate init, which assigns this
    // separately, out of -Wmissing-field-initializers.
    std::string message{};
    // The last `change` / `increase` / `decrease` this chain made, which `.by`
    // reads.
    std::optional<DeltaRecord> delta{};
    // How an unknown member names the chain it was read on. A string literal:
    // `pm.response.to.have.responseTime` starts a chain of its own here.
    const char* path = "pm.expect(...)";
    // Whether the unknown-member hook is live. `create_expectation` installs
    // every member first and sets this last: defining a property looks up the
    // existing own property, so a hook armed from the start would reject the
    // chain's own members as they are installed.
    bool armed = false;
};

// Names the engine probes on any value. "No own property" for them keeps
// JSON.stringify and promise resolution working, where reporting them as
// misspelled assertions would make `console.log` of an assertion throw; they
// are not on Object.prototype, so the prototype check does not cover them.
constexpr const char* chain_passthrough_members[] = { "toJSON", "then" };

} // namespace

/**
 * The body every assertion chain's unknown-member hook shares: a name the
 * object does not implement is a misspelled or unimplemented assertion and
 * throws naming @p path; the plumbing a runtime probes keeps resolving. Answers
 * QuickJS's `get_own_property` convention: 0 to continue the lookup, -1 with a
 * pending exception. One copy for `pm.response.to`, `pm.expect(...)` and
 * `.within`, which differ only in how each is armed and the path it names; a
 * second copy of the passthrough rules would miss the next fix.
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
 * Turns an unrecognised member of an expectation into a throw.
 * `pm.expect(x).to.be.NaN` is an expression statement, so an unimplemented
 * member is `undefined`, asserts nothing, and the test passes whatever the
 * value: the worst answer for a matcher meant to check something.
 * `pm.response.to` throws by name (#487); this applies the rule to the other
 * chain, covering every matcher chai has and Vayu lacks, present and future,
 * and every typo. The state's `armed` flag lets `create_expectation` install
 * the chain's own members first (`ExpectState::armed`).
 */
int expect_unknown_member (JSContext* ctx, JSPropertyDescriptor* desc, JSValueConst obj, JSAtom prop) {
    (void)desc;
    const auto* state =
    static_cast<const ExpectState*> (JS_GetOpaque (obj, expect_class_id));
    if (!state || !state->armed) {
        return 0;
    }
    return report_unknown_chain_member (ctx, obj, prop, state->path);
}

// Value-initialized, then assigned, not a designated initializer, for
// `response_chain_exotic`'s reason (pm_response.cpp): naming one of the
// struct's seven hooks leaves six -Wmissing-field-initializers warnings.
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

// ----------------------------------------------------------------------------
// The callable members of an expectation (#2528). A matcher (`equal`, `within`)
// and a chainable method (`include`, `length`, `a`) are objects of one callable
// class, not C functions: a function carries `name`, `length` and
// Function.prototype's `call` / `apply` / `bind`, so `.include.name` or
// `.within.foo` would be a value and a paren-less chain pass having asserted
// nothing (#999). This class has no own properties; its hook decides every name
// read off it.
// ----------------------------------------------------------------------------

JSClassID expect_member_class_id = 0;

namespace {

enum class MemberShape {
    // A matcher call. Nothing is read off it, so every name but the plumbing
    // `report_unknown_chain_member` lets through is refused.
    Method,
    // chai's chainable method: a call and the rest of the chain. Its prototype
    // is the expectation, which answers or refuses every name but `length`,
    // refused as chai's length guard does: `.include.length` reads as the
    // matcher `length` and is almost always a mistake.
    Chainable,
};

// One member, static for the life of the process: the object's opaque points
// here, so the class needs no finalizer.
struct ExpectMember {
    // How an error names the member after its chain's path. Empty for
    // `responseTime` / `responseSize`, whose expectation's path ends with it.
    const char* name       = "";
    JSCFunctionMagic* call = nullptr;
    int magic              = 0;
    // The arity a C function would have: QuickJS pads `argv` to it, and the
    // matchers read their optional arguments on that promise.
    int length        = 0;
    MemberShape shape = MemberShape::Method;
};

constexpr int MEMBER_ARITY_LIMIT = 2;

const ExpectMember* member_row (JSValueConst obj) {
    return static_cast<const ExpectMember*> (JS_GetOpaque (obj, expect_member_class_id));
}

bool is_length_atom (JSContext* ctx, JSAtom prop) {
    JSAtom length   = JS_NewAtom (ctx, "length");
    const bool same = prop == length;
    JS_FreeAtom (ctx, length);
    return same;
}

int expect_member_unknown_member (JSContext* ctx,
JSPropertyDescriptor* desc,
JSValueConst obj,
JSAtom prop) {
    (void)desc;
    const ExpectMember* member = member_row (obj);
    if (member == nullptr) {
        return 0;
    }
    if (member->shape == MemberShape::Method) {
        const std::string path = std::string ("pm.expect(...).") + member->name;
        return report_unknown_chain_member (ctx, obj, prop, path.c_str ());
    }
    if (!is_length_atom (ctx, prop)) {
        return 0;
    }
    ScopedValue expectation (ctx, JS_GetPrototype (ctx, obj));
    const auto* state = static_cast<const ExpectState*> (
    JS_GetOpaque (expectation.get (), expect_class_id));
    const std::string path = std::string (state ? state->path : "pm.expect(...)") +
    (*member->name != '\0' ? "." : "") + member->name;
    JS_ThrowTypeError (ctx, "%s.length is not a supported assertion; after a chainable method write lengthOf",
    path.c_str ());
    return -1;
}

/**
 * A member's call. A matcher keeps the `this` it was called on (the
 * expectation, or a chainable method standing in for it); a chainable method
 * calls on its prototype, the expectation it was read from.
 */
JSValue expect_member_call (JSContext* ctx,
JSValueConst func_obj,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int flags) {
    (void)flags;
    const ExpectMember* member = member_row (func_obj);
    if (member == nullptr) {
        return JS_ThrowInternalError (ctx, "Invalid expectation member");
    }
    std::array<JSValueConst, MEMBER_ARITY_LIMIT> padded{};
    if (argc < member->length) {
        padded.fill (JS_UNDEFINED);
        std::copy_n (argv, argc, padded.begin ());
        argv = padded.data ();
    }
    if (member->shape == MemberShape::Method) {
        return member->call (ctx, this_val, argc, argv, member->magic);
    }
    ScopedValue expectation (ctx, JS_GetPrototype (ctx, func_obj));
    return member->call (ctx, expectation.get (), argc, argv, member->magic);
}

JSClassExoticMethods expect_member_exotic = [] {
    JSClassExoticMethods exotic{};
    exotic.get_own_property = expect_member_unknown_member;
    return exotic;
}();

} // namespace

JSClassDef expect_member_class = { .class_name = "ExpectationMember",
    .finalizer                                 = nullptr,
    .gc_mark                                   = nullptr,
    .call                                      = expect_member_call,
    .exotic                                    = &expect_member_exotic };

namespace {

/**
 * The expectation a member was reached on, as a new reference, or `undefined`.
 * `this` is the expectation, or a chainable method like `.include` or `.length`
 * read off it, whose prototype is the expectation (`chainable_method`):
 * `.include.keys(...)` finds `keys` through it and calls it with the chainable
 * method as `this`.
 */
JSValue expectation_object (JSContext* ctx, JSValueConst this_val) {
    if (JS_GetOpaque (this_val, expect_class_id) != nullptr) {
        return JS_DupValue (ctx, this_val);
    }
    const ExpectMember* member = member_row (this_val);
    if (member == nullptr || member->shape != MemberShape::Chainable) {
        return JS_UNDEFINED;
    }
    JSValue proto = JS_GetPrototype (ctx, this_val);
    if (JS_GetOpaque (proto, expect_class_id) != nullptr) {
        return proto;
    }
    JS_FreeValue (ctx, proto);
    return JS_UNDEFINED;
}

// The state behind `this`, by the rule above. The object it belongs to is held
// by `this_val` (directly or as its prototype), so the pointer outlives the
// reference taken to find it.
ExpectState* expectation_state (JSContext* ctx, JSValueConst this_val) {
    ScopedValue expectation (ctx, expectation_object (ctx, this_val));
    return static_cast<ExpectState*> (JS_GetOpaque (expectation.get (), expect_class_id));
}

// Every callable matcher returns the expectation, not `undefined`, which makes
// `.and` work: a plain passthrough, with the flags a chain set (`not` included)
// persisting across it as in chai. The expectation, never the chainable method
// `this` may be: `.include.keys('a')` answers the chain, not a function that
// would call `include` again.
JSValue expect_chained (JSContext* ctx, JSValueConst this_val) {
    return expectation_object (ctx, this_val);
}

} // namespace

/**
 * Throws a failed assertion as chai does, as an `AssertionError` (#487): a
 * `TypeError` would prefix every failure in the report and console with
 * `TypeError:`, reading as an engine fault, and a script inspecting what it
 * caught (`e.name === "AssertionError"`) would branch differently than in
 * Postman. QuickJS has no `AssertionError`, so this is a plain `Error` renamed:
 * `instanceof Error` holds, `JS_NewError` gives a native backtrace, and
 * `message` has the native attributes (writable, configurable, **not**
 * enumerable), so `JSON.stringify(e)` is unchanged. No `AssertionError` global:
 * chai's lives on `require('chai')` (#2655, a separate library), and a bare
 * global would be a name Postman scripts cannot rely on.
 *
 * Only assertion failures come here, including chai's type checks made as
 * assertions, in both polarities: a non-array `members` target, a `length` read
 * off a target with none, an `include` pair chai has no rule for (#2582). A
 * script-text mistake stays a `TypeError`: a matcher called with no or a
 * malformed argument (`members` given a non-array, `keys()` with no names), a
 * misspelled name, the ordering matchers' refusal of a non-number, non-Date.
 * Nothing was asserted; the call was wrong.
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
 * Reports a failed assertion prefixed with the expectation's message: chai's
 * `expect(value, message)` puts the script's words before the matcher's (the
 * generic text says what broke, the prefix which value: the third item in a
 * loop, the MCP path), a form Postman scripts use routinely. Every matcher
 * throws through here, so the prefix is one rule: a later matcher gets it by
 * throwing like its neighbours. Usage errors (`above()` with no argument,
 * `members()` given a non-array) deliberately do not: they name a script-text
 * mistake, not the value under test, and already name their matcher.
 */
JSValue throw_expect_failure (JSContext* ctx, const ExpectState* state, const std::string& failure) {
    if (state != nullptr && !state->message.empty ()) {
        return throw_assertion_failure (ctx, state->message + ": " + failure);
    }
    return throw_assertion_failure (ctx, failure);
}

// ----------------------------------------------------------------------------
// Value comparison for the equality matchers. `equal` is strict and `eql` deep,
// so they cannot share one comparison: `expect({a:1}).to.equal({a:1})` fails
// (different references) where `.eql` passes, chai's line, which Postman
// scripts are written against.
// ----------------------------------------------------------------------------

// `===` without coercion. No strict-equality entry point exists in both
// vendored runtimes (`JS_IsStrictEqual` is quickjs-ng's; the Unix build is
// Bellard's), so the rules are applied here: no cross-type equality, `NaN`
// unequal to itself, objects by reference.
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

// An object's internal class as `Object.prototype.toString` reports it
// ("[object Date]"). The deep compare needs it: a `Date` or `Map` keeps its
// contents outside the own-property list, so comparing enumerable keys alone
// would call every pair equal. `JS_IsDate` / `JS_IsRegExp` exist only in
// quickjs-ng, so this asks the language. `failed`, when given, is set if the
// call threw and the exception is left pending: an empty tag otherwise looks
// like an unrecognised class, and a caller that cannot tell them apart reports
// a result for a comparison that never happened (#959, a thrown error read as a
// silent "not equal" on one platform).
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

// How a value reads in an assertion failure: `JS_ToCString` renders every
// object "[object Object]", telling the author nothing about which key
// differed, so JSON, what they wrote; a RegExp excepted, as JSON renders it
// "{}" and its `toString` is the pattern.
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

// A cyclic structure would recurse forever; two things stop it. The **cycle
// check** is the real one: `js_deep_equal` carries the object pair at each
// level of the path, and a pair already being compared is a cycle, reported
// where it closes (depth 1 for `a.self = a`). The **depth cap** is a backstop
// for a structure merely enormous; nothing a script asserts on nests this far.
//
// The cap alone is not enough (#959): it bounds the recursion after the fact,
// and 64 frames are a different stack size per toolchain. On MSVC at /Od with
// ASan's redzones, QuickJS's 256 KB stack guard tripped first, inside
// `js_class_tag`'s `JS_Call`: an empty tag matched the other empty tag, fell
// through to "unrecognised class" and `return 0`, dropping the pending
// overflow, so one input answered differently per platform. Detecting the cycle
// where it closes keeps the cyclic case shallow on every toolchain.
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

// Deep structural equality: 1 (equal), 0 (not equal) or -1 with a pending
// exception, the QuickJS convention. Not through `JSON.stringify`, which is
// key-order sensitive ({a:1,b:2} vs {b:2,a:1} unequal), drops `undefined`
// members, and cannot see a value it fails to serialise.
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
    // Both branches render each side through script the author may have written
    // (an own `toJSON`, an overridden `toString`), and both renderers answer ""
    // when it throws, leaving the exception pending; two empty renderings
    // compare equal, so two throwing Dates would pass. The renderers report no
    // failure, so the context is asked, after each side: `JS_Throw` replaces
    // the pending exception, so rendering b over an a that threw would report
    // b's error for a's read.
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
        // Map, Set, typed arrays and the like hold their contents where a
        // structural compare cannot see, so every pair would look equal: report
        // unequal rather than pass silently; reference identity already matched
        // the certain case.
        return 0;
    }

    // Every read below can run script: an author's getter or a Proxy trap
    // (`IsArray` unwraps a proxy, so a proxied array lands here and even its
    // `length` is a trap). A throwing read leaves the exception pending and
    // returns the sentinel, neither number nor object, so comparing it would
    // report "not deeply equal" about a read that never happened, #959's shape
    // one level down. Each pair stops at the first side that throws: reading
    // the second runs more script and could replace the error the author is
    // owed.
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

// The length of an array the caller has already checked is one.
uint32_t js_array_length (JSContext* ctx, JSValueConst array) {
    JSValue length_val = JS_GetPropertyStr (ctx, array, "length");
    uint32_t len       = 0;
    JS_ToUint32 (ctx, &len, length_val);
    JS_FreeValue (ctx, length_val);
    return len;
}

/**
 * Whether the array @p target holds an element equal to @p needle by the
 * chain's comparison: 1, 0, or -1 with a pending exception. An element behind a
 * throwing getter is a read that did not happen; the sentinel would answer "not
 * a member", a pass under `.not`.
 */
int array_holds (JSContext* ctx, JSValueConst target, JSValueConst needle, bool deep) {
    const uint32_t len = js_array_length (ctx, target);
    for (uint32_t i = 0; i < len; i++) {
        ScopedValue elem (ctx, JS_GetPropertyUint32 (ctx, target, i));
        if (JS_IsException (elem.get ())) {
            return -1;
        }
        const int same = js_compare_for_chain (ctx, elem.get (), needle, deep);
        if (same != 0) {
            return same;
        }
    }
    return 0;
}

/**
 * A Map's or Set's contents as a new array: what the target's own @p method
 * (`keys` or `values`) iterates, or the exception. A Set's keys are its
 * members, so `keys` reads the same list from either; the target's own method
 * is called, as chai calls its own `forEach`.
 */
JSValue collection_contents (JSContext* ctx, JSValueConst target, const char* method) {
    const ScopedValue read (ctx, JS_GetPropertyStr (ctx, target, method));
    if (JS_IsException (read.get ())) {
        return JS_EXCEPTION;
    }
    const ScopedValue iterator (ctx, JS_Call (ctx, read.get (), target, 0, nullptr));
    if (JS_IsException (iterator.get ())) {
        return JS_EXCEPTION;
    }
    const ScopedValue global (ctx, JS_GetGlobalObject (ctx));
    const ScopedValue array (ctx, JS_GetPropertyStr (ctx, global.get (), "Array"));
    const ScopedValue from (ctx, JS_GetPropertyStr (ctx, array.get (), "from"));
    JSValueConst source = iterator.get ();
    return JS_Call (ctx, from.get (), array.get (), 1, &source);
}

JSValue expect_to_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    return expect_chained (ctx, this_val);
}

/**
 * `.not`: negates the rest of this chain. A **set**, not a toggle, chai's rule
 * (`flag(this, 'negate', true)`) and the only one surviving more than one
 * `.not` (#883): toggling would make every even `.not` cancel the previous, so
 * `expect(x).to.not.include("+").and.to.not.include("/")` would assert x does
 * include "/". Nothing resets the flag between a chain's assertions, so a
 * second `.not` is a no-op, not an inversion.
 */
JSValue expect_not_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
    if (state) {
        state->negated = true;
    }
    return expect_chained (ctx, this_val);
}

JSValue expect_be_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    return expect_chained (ctx, this_val);
}

// The flag-setting chainers: each changes what the chain's final matcher
// compares, then hands the expectation back. `any` and `all` are one flag, as
// in chai, each clearing the other, the later word winning. The index is the
// getter's registered magic.
struct FlagChainer {
    const char* name;
    bool ExpectState::* flag;
    bool value;
};
constexpr auto flag_chainers = std::to_array<FlagChainer> ({
{ "deep", &ExpectState::deep, true },
{ "nested", &ExpectState::nested, true },
{ "own", &ExpectState::own, true },
{ "ordered", &ExpectState::ordered, true },
{ "any", &ExpectState::any_key, true },
{ "all", &ExpectState::any_key, false },
{ "itself", &ExpectState::itself, true },
});

JSValue
expect_flag_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)argc;
    (void)argv;
    const FlagChainer& chainer = flag_chainers.at (static_cast<size_t> (magic));
    if (auto* state = expectation_state (ctx, this_val)) {
        state->*chainer.flag = chainer.value;
    }
    return expect_chained (ctx, this_val);
}

// `equal` and `eql`'s shared body: `eql` is deep whatever the chain said,
// `equal` strict unless `deep` set the flag.
JSValue
expect_equality (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, bool always_deep) {
    if (argc < 1) {
        return JS_ThrowTypeError (
        ctx, "%s() requires an argument", always_deep ? "eql" : "equal");
    }

    auto* state = expectation_state (ctx, this_val);
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
    auto* state = expectation_state (ctx, this_val);
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
 * `.to.be.true` / `.to.be.false`: the boolean itself, not its truthiness, as
 * chai compares with `=== true` / `=== false`; `.ok` is the coercing matcher
 * and keeps `JS_ToBool` (#2523).
 */
JSValue expect_boolean_literal (JSContext* ctx, JSValueConst this_val, bool expected) {
    auto* state = expectation_state (ctx, this_val);
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
 * The value an ordering matcher compares, or nothing. chai orders numbers and
 * Dates and **type-asserts both sides** rather than coercing:
 * `expect("5").to.be.above(3)` is an error, not a pass; `ToNumber` would read
 * "5" as 5, `true` as 1, `[5]` as 5 and `null` as 0, returning a verdict on a
 * comparison the script never meant. A Date reads as its instant. The kind
 * comes back with the value because chai compares number with number and Date
 * with Date, refusing the mixed pair rather than reading the Date as
 * milliseconds.
 *
 * @p failed is set when reading the value raised, the exception left pending:
 * #959's rule for the deep compare, as "could not be read" and "not a number"
 * are different answers and only one is true.
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

/**
 * What `.length` / `.lengthOf` measure: `length`, except on a Map or Set,
 * measured by `size`. The descriptor travels with the number so a failure says
 * which it read.
 */
enum class LengthRead { Found, Missing, Failed };

struct LengthSubject {
    LengthRead status      = LengthRead::Missing;
    double value           = 0;
    const char* descriptor = "length";
};

LengthSubject read_length_subject (JSContext* ctx, JSValueConst target) {
    LengthSubject out;
    if (JS_IsObject (target) && !JS_IsArray (target)) {
        bool tag_failed       = false;
        const std::string tag = js_class_tag (ctx, target, &tag_failed);
        if (tag_failed) {
            out.status = LengthRead::Failed;
            return out;
        }
        if (tag == "[object Map]" || tag == "[object Set]") {
            out.descriptor = "size";
        }
    }

    ScopedValue measured (ctx, JS_GetPropertyStr (ctx, target, out.descriptor));
    // A measurement the read could not produce is neither absent nor a number:
    // the script's own error is the answer, not the missing-length assertion
    // nor a comparison against an uninitialised double.
    if (JS_IsException (measured.get ())) {
        out.status = LengthRead::Failed;
    } else if (JS_IsUndefined (measured.get ())) {
        out.status = LengthRead::Missing;
    } else if (JS_ToFloat64 (ctx, &out.value, measured.get ()) < 0) {
        out.status = LengthRead::Failed;
    } else {
        out.status = LengthRead::Found;
    }
    return out;
}

// The throw to propagate when the length could not be read, nothing when it
// could. A target with no length is chai's `to.have.property('length')`
// failing, an assertion in both polarities: `.not` negates the comparison
// after it, never the measurement.
std::optional<JSValue>
length_read_refusal (JSContext* ctx, const ExpectState& state, const LengthSubject& subject) {
    switch (subject.status) {
    case LengthRead::Found: return std::nullopt;
    case LengthRead::Failed: return JS_EXCEPTION;
    case LengthRead::Missing: break;
    }
    return throw_expect_failure (ctx, &state,
    "Expected " + js_describe (ctx, state.actual) + " to have property '" +
    subject.descriptor + "'");
}

// The ordering matchers differ in one comparison and one word, so one function
// reached by magic, not a copy each: the type assertion is the same rule in
// all, and a copy is what a fix would miss. The aliases (`gt`, `greaterThan`,
// ...) are rows naming the relation they share, a row per registered name.
enum class Relation { Above, Below, AtLeast, AtMost, Within };

struct OrderingMatcher {
    const char* name;
    const char* relation;
    Relation which;
};
constexpr auto ordering_matchers = std::to_array<OrderingMatcher> ({
{ "above", "above", Relation::Above },
{ "below", "below", Relation::Below },
{ "least", "at least", Relation::AtLeast },
{ "most", "at most", Relation::AtMost },
{ "gt", "above", Relation::Above },
{ "greaterThan", "above", Relation::Above },
{ "lt", "below", Relation::Below },
{ "lessThan", "below", Relation::Below },
{ "gte", "at least", Relation::AtLeast },
{ "greaterThanOrEqual", "at least", Relation::AtLeast },
{ "lte", "at most", Relation::AtMost },
{ "lessThanOrEqual", "at most", Relation::AtMost },
{ "within", "within", Relation::Within },
});

// A matcher's registered magic is its table index, read back by
// `expect_ordering`. The count is asserted so a new row is a decision made
// here, beside `ordering_holds` and the completion entry every name needs, not
// one registered without either: an ordering matcher silently answering the
// wrong comparison is the failure this file exists to stop.
static_assert (std::size (ordering_matchers) == 13,
"a new ordering row needs its completion entry, and an arm in ordering_holds "
"if "
"it is a new relation");

// `within` is the one relation with two bounds, both inclusive as in chai.
constexpr size_t ordering_bound_count (const OrderingMatcher& matcher) {
    return matcher.which == Relation::Within ? 2 : 1;
}

bool ordering_holds (Relation which, double actual, double lower, double upper) {
    switch (which) {
    case Relation::Above: return actual > lower;
    case Relation::Below: return actual < lower;
    case Relation::AtLeast: return actual >= lower;
    case Relation::AtMost: return actual <= lower;
    case Relation::Within: return actual >= lower && actual <= upper;
    }
    return false;
}

// The target and the bounds an ordering matcher compares, already
// type-checked. `measured` names what was measured (`length` or `size`) under
// `.length` and is null when the target itself was compared.
struct OrderingOperands {
    OrderingValue actual;
    std::array<OrderingValue, 2> bounds;
    const char* measured = nullptr;
};

// The throw for an operand of the wrong kind, nothing when the target and every
// bound can be compared with one another.
std::optional<JSValue> refuse_ordering_kinds (JSContext* ctx,
const OrderingMatcher& matcher,
const OrderingOperands& operands,
const ExpectState& state,
JSValueConst* argv) {
    if (operands.actual.kind == OrderingKind::NotOrderable) {
        return JS_ThrowTypeError (ctx, "%s() expects the target to be a number or a Date, got %s",
        matcher.name, js_type_name (ctx, state.actual));
    }
    for (size_t i = 0; i < ordering_bound_count (matcher); i++) {
        const OrderingValue& bound = operands.bounds.at (i);
        if (bound.kind == OrderingKind::NotOrderable) {
            return JS_ThrowTypeError (ctx, "%s() expects a number or a Date, got %s",
            matcher.name, js_type_name (ctx, argv[i]));
        }
        // chai orders like with like: a Date read as milliseconds against a
        // number is a comparison neither side asked for, so the mixed pair is
        // refused rather than answered.
        if (operands.actual.kind != bound.kind) {
            return JS_ThrowTypeError (ctx,
            "%s() compares a number with a number and a Date with a "
            "Date, got %s and %s",
            matcher.name, ordering_kind_name (operands.actual.kind),
            ordering_kind_name (bound.kind));
        }
    }
    return std::nullopt;
}

// Reads the target (its length under `.length`) and the bounds. Answers the
// throw to propagate when one of them cannot be compared.
std::optional<JSValue> read_ordering_operands (JSContext* ctx,
const ExpectState& state,
const OrderingMatcher& matcher,
JSValueConst* argv,
OrderingOperands& operands) {
    bool failed = false;
    if (state.do_length) {
        const LengthSubject length = read_length_subject (ctx, state.actual);
        if (auto refusal = length_read_refusal (ctx, state, length)) {
            return refusal;
        }
        operands.actual   = { OrderingKind::Number, length.value };
        operands.measured = length.descriptor;
    } else {
        operands.actual = js_ordering_value (ctx, state.actual, failed);
    }
    for (size_t i = 0; i < ordering_bound_count (matcher) && !failed; i++) {
        operands.bounds.at (i) = js_ordering_value (ctx, argv[i], failed);
    }
    if (failed) {
        return JS_EXCEPTION;
    }
    return refuse_ordering_kinds (ctx, matcher, operands, state, argv);
}

std::string ordering_failure_message (JSContext* ctx,
const ExpectState& state,
const OrderingMatcher& matcher,
const OrderingOperands& operands,
JSValueConst* argv) {
    std::string message = "Expected ";
    if (operands.measured != nullptr) {
        message += std::string (operands.measured) + " " +
        js_describe (ctx, JS_NewFloat64 (ctx, operands.actual.value));
    } else {
        message += js_describe (ctx, state.actual);
    }
    message += state.negated ? " to not be " : " to be ";
    message += std::string (matcher.relation) + " " + js_describe (ctx, argv[0]);
    if (matcher.which == Relation::Within) {
        message += ".." + js_describe (ctx, argv[1]);
    }
    return message;
}

JSValue
expect_ordering (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    const auto& matcher = ordering_matchers.at (static_cast<size_t> (magic));
    if (argc < static_cast<int> (ordering_bound_count (matcher))) {
        if (matcher.which == Relation::Within) {
            return JS_ThrowTypeError (ctx, "within() requires a start and a finish");
        }
        return JS_ThrowTypeError (ctx, "%s() requires an argument", matcher.name);
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    OrderingOperands operands;
    if (auto refusal = read_ordering_operands (ctx, *state, matcher, argv, operands)) {
        return *refusal;
    }

    const bool holds = ordering_holds (matcher.which, operands.actual.value,
    operands.bounds.at (0).value, operands.bounds.at (1).value);
    const bool pass  = state->negated ? !holds : holds;
    if (!pass) {
        return throw_expect_failure (ctx, state,
        ordering_failure_message (ctx, *state, matcher, operands, argv));
    }

    return expect_chained (ctx, this_val);
}

// Splits a `nested.property` path into segments ("a.b[0].c" walks a, b, 0, c),
// left to right, a `[` opening an index. Chai's escape form (`a\.b` for a
// literal dot) is not supported.
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

// The segments a property name walks: a path under `nested`, the name itself
// otherwise.
std::vector<std::string>
property_segments (const ExpectState& state, const std::string& name) {
    return state.nested ? split_property_path (name) : std::vector<std::string>{ name };
}

// chai refuses `nested` with `own` rather than choosing: an own property at a
// path's end is a question neither flag asks. The throw to propagate, or
// nothing when the chain asks one question.
std::optional<JSValue>
refuse_nested_own (JSContext* ctx, const ExpectState& state, const char* matcher) {
    if (state.nested && state.own) {
        return JS_ThrowTypeError (
        ctx, "%s() cannot combine the nested and own flags", matcher);
    }
    return std::nullopt;
}

// "deep own property", chai's descriptor, so a failure says which flags
// decided what was looked at.
std::string property_descriptor (const ExpectState& state) {
    std::string out;
    if (state.deep) {
        out += "deep ";
    }
    if (state.own) {
        out += "own ";
    }
    if (state.nested) {
        out += "nested ";
    }
    return out + "property";
}

enum class PropertyPresence { Present, Absent, Failed };

/**
 * Whether @p target holds the property @p segments walk to. The walk stops at
 * the last segment's parent, so a missing intermediate is a missing property,
 * not a thrown "cannot read property of undefined"; a plain chain has one
 * segment. The last is tested with `hasOwnProperty` under @p own, else with
 * `in`, neither running a getter; when @p value is given and the property is
 * present, it receives the value as a new reference, the first and only read.
 *
 * A primitive is read through its wrapper object, as chai does
 * (`name in Object(obj)`, `hasOwnProperty.call(obj, name)`), so `'abc'` has an
 * own `length` and `0`; only `null` and `undefined` hold nothing. `Failed`
 * leaves the exception pending: a segment behind a throwing getter is an
 * unfinished walk, and calling it absent would make `.not` pass.
 */
PropertyPresence find_chain_property (JSContext* ctx,
JSValueConst target,
const std::vector<std::string>& segments,
bool own,
JSValue* value) {
    if (segments.empty ()) {
        return PropertyPresence::Absent;
    }
    const auto holds_nothing = [] (JSValueConst v) {
        return JS_IsNull (v) || JS_IsUndefined (v);
    };
    JSValue holder = JS_DupValue (ctx, target);
    for (size_t i = 0; i + 1 < segments.size (); i++) {
        if (holds_nothing (holder)) {
            JS_FreeValue (ctx, holder);
            return PropertyPresence::Absent;
        }
        JSValue next = JS_GetPropertyStr (ctx, holder, segments[i].c_str ());
        JS_FreeValue (ctx, holder);
        if (JS_IsException (next)) {
            return PropertyPresence::Failed;
        }
        holder = next;
    }
    const ScopedValue walked (ctx, holder);
    if (holds_nothing (walked.get ())) {
        return PropertyPresence::Absent;
    }
    // The own-property read needs an object; an object converts to itself.
    const ScopedValue parent (ctx, JS_ToObject (ctx, walked.get ()));
    if (JS_IsException (parent.get ())) {
        return PropertyPresence::Failed;
    }

    JSAtom atom = JS_NewAtom (ctx, segments.back ().c_str ());
    const int present = own ? JS_GetOwnProperty (ctx, nullptr, parent.get (), atom) :
                              JS_HasProperty (ctx, parent.get (), atom);
    if (present > 0 && value != nullptr) {
        *value = JS_GetProperty (ctx, parent.get (), atom);
    }
    JS_FreeAtom (ctx, atom);
    if (present < 0 || (present > 0 && value != nullptr && JS_IsException (*value))) {
        return PropertyPresence::Failed;
    }
    return present > 0 ? PropertyPresence::Present : PropertyPresence::Absent;
}

/**
 * chai's `.include` against an object target: subset matching. Every own
 * enumerable key of @p expected must be on @p target with an equal value by the
 * chain's rules: `include` strict per key, `deep.include` deep, `own.include`
 * own properties only, `nested.include` each key a path (chai running
 * `.property` per key with the flags). 1, 0, or -1 with a pending exception; a
 * primitive target reads through its wrapper, as chai's per-key assertion does.
 *
 * An expectation with no own enumerable keys is refused: chai finds none,
 * asserts nothing and passes both ways, so an empty computed subset is a green
 * test that compared nothing. A Date, a RegExp and a function land here, each
 * reading as an assertion with no key to check.
 */
int expect_object_subset (JSContext* ctx, const ExpectState& state, JSValueConst expected) {
    std::vector<std::string> keys;
    if (!js_own_enumerable_keys (ctx, expected, keys)) {
        return -1;
    }
    if (keys.empty ()) {
        JS_ThrowTypeError (ctx,
        "include() was given %s with no properties to match, which would "
        "assert nothing",
        js_describe (ctx, expected).c_str ());
        return -1;
    }
    if (refuse_nested_own (ctx, state, "include")) {
        return -1;
    }

    for (const auto& key : keys) {
        // A throwing getter is a read that did not happen, not a mismatch: the
        // exception is reported, not answered "these differ", which under
        // `.not` would pass (the deep compare's rule, #959).
        JSValue held_value              = JS_UNDEFINED;
        const PropertyPresence presence = find_chain_property (ctx,
        state.actual, property_segments (state, key), state.own, &held_value);
        const ScopedValue held (ctx, held_value);
        if (presence != PropertyPresence::Present) {
            return presence == PropertyPresence::Failed ? -1 : 0;
        }
        ScopedValue wanted (ctx, JS_GetPropertyStr (ctx, expected, key.c_str ()));
        if (JS_IsException (wanted.get ())) {
            return -1;
        }
        const int same =
        js_compare_for_chain (ctx, held.get (), wanted.get (), state.deep);
        if (same != 1) {
            return same;
        }
    }
    return 1;
}

/**
 * chai's `include` on a Map or Set: whether a Map holds @p needle as a value
 * (never a key) or a Set as a member. Strictly SameValueZero, what
 * `Set.prototype.has` answers, so `NaN` finds `NaN`; under `deep`, deep-eql. 1,
 * 0, or -1 with a pending exception.
 */
int collection_includes (JSContext* ctx, const ExpectState& state, JSValueConst needle) {
    const ScopedValue values (ctx, collection_contents (ctx, state.actual, "values"));
    if (JS_IsException (values.get ())) {
        return -1;
    }
    const uint32_t len = js_array_length (ctx, values.get ());
    for (uint32_t i = 0; i < len; i++) {
        const ScopedValue held (ctx, JS_GetPropertyUint32 (ctx, values.get (), i));
        if (JS_IsException (held.get ())) {
            return -1;
        }
        const int same = state.deep ?
        js_compare_for_chain (ctx, held.get (), needle, true) :
        (JS_IsSameValueZero (ctx, held.get (), needle) ? 1 : 0);
        if (same != 0) {
            return same;
        }
    }
    return 0;
}

// chai's refusal of a pair `include` has no rule for (a number target, an
// object target given a primitive). chai raises it as an assertion, in both
// polarities, so a `.not` cannot turn it into a pass.
int refuse_include_combination (JSContext* ctx, const ExpectState& state, JSValueConst needle) {
    const char* needle_type = js_type_name (ctx, needle);
    throw_expect_failure (ctx, &state,
    std::format (
    "the given combination of arguments ({} and {}) is invalid for "
    "this assertion. You can use an array, a map, an object, a set, "
    "a string, or a weakset instead of a {}",
    js_type_name (ctx, state.actual), needle_type, needle_type));
    return -1;
}

/**
 * Whether the target holds @p needle by chai's `include` rule for its type: 1,
 * 0, or -1 with a pending exception. A Url or RequestBody reads as its string
 * (#991, #1003; `expect_string_like`), and a boxed `String` is a string to
 * chai's type-detect too. @p subject receives what the object branch matched,
 * for the failure: "own properties " when the flags narrowed it, else empty.
 */
int include_holds (JSContext* ctx, const ExpectState& state, JSValueConst needle, std::string& subject) {
    if (auto text = expect_string_like (ctx, state.actual)) {
        return text->find (js_to_string (ctx, needle)) != std::string::npos ? 1 : 0;
    }
    if (JS_IsArray (state.actual)) {
        return array_holds (ctx, state.actual, needle, state.deep);
    }
    if (JS_IsObject (state.actual)) {
        bool tag_failed       = false;
        const std::string tag = js_class_tag (ctx, state.actual, &tag_failed);
        if (tag_failed) {
            return -1;
        }
        if (tag == "[object Map]" || tag == "[object Set]") {
            return collection_includes (ctx, state, needle);
        }
        if (tag == "[object String]") {
            const std::string text = js_to_string (ctx, state.actual);
            if (JS_HasException (ctx)) {
                return -1;
            }
            return text.find (js_to_string (ctx, needle)) != std::string::npos ? 1 : 0;
        }
    }
    if (!JS_IsObject (needle)) {
        return refuse_include_combination (ctx, state, needle);
    }
    if (state.own || state.nested) {
        subject = state.own ? "own properties " : "nested properties ";
    }
    return expect_object_subset (ctx, state, needle);
}

JSValue expect_include (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "include() requires an argument");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    std::string subject;
    const int held = include_holds (ctx, *state, argv[0], subject);
    if (held < 0) {
        return JS_EXCEPTION;
    }
    const bool includes = held == 1;
    const bool pass     = state->negated ? !includes : includes;

    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not include " : " to include ") + subject +
        js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

JSValue create_expectation (JSContext* ctx, JSValue actual, std::string message);

// What `.property(name)` returns: the chain with the property's value as its
// subject, so `.that.is.a("number")` and `.and.equal(1)` assert on the value.
// The flags describing how a matcher reads its subject (`deep`, `nested`,
// `own`, `contains`, `any`, `ordered`, `itself`) and the failure message carry
// over, as on chai's one assertion object; `not` does not, since a retarget
// happens only on a passing positive assertion and nothing negated the new
// subject.
JSValue expect_on_property_value (JSContext* ctx, const ExpectState* state, JSValueConst value) {
    JSValue next = create_expectation (ctx, value, state->message);
    if (JS_IsException (next)) {
        return next;
    }
    auto* next_state = static_cast<ExpectState*> (JS_GetOpaque (next, expect_class_id));
    next_state->deep     = state->deep;
    next_state->nested   = state->nested;
    next_state->own      = state->own;
    next_state->contains = state->contains;
    next_state->any_key  = state->any_key;
    next_state->ordered  = state->ordered;
    next_state->itself   = state->itself;
    return next;
}

JSValue expect_have_property (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "property() requires a property name");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    if (auto refusal = refuse_nested_own (ctx, *state, "property")) {
        return *refusal;
    }
    const std::string prop_name = js_to_string (ctx, argv[0]);
    const std::vector<std::string> segments = property_segments (*state, prop_name);
    if (segments.empty ()) {
        return JS_ThrowTypeError (ctx, "property() requires a property name");
    }

    // The value form compares the value and the one-argument form hands it on,
    // so both ask the lookup for it and a getter runs once;
    // `.not.property(name)` asserts absence and reads no value.
    const bool value_form = argc >= 2;
    const bool retargets  = !value_form && !state->negated;
    JSValue read_value    = JS_UNDEFINED;
    const auto presence   = find_chain_property (ctx, state->actual, segments,
    state->own, (value_form || retargets) ? &read_value : nullptr);
    const ScopedValue property_value (ctx, read_value);
    if (presence == PropertyPresence::Failed) {
        return JS_EXCEPTION;
    }
    bool has_prop = presence == PropertyPresence::Present;

    // A second argument checks the value too, strictly unless the chain is
    // `deep`, so not by stringify: two objects with one JSON are different
    // references.
    if (has_prop && value_form) {
        const int same =
        js_compare_for_chain (ctx, property_value.get (), argv[1], state->deep);
        if (same < 0) {
            return JS_EXCEPTION;
        }
        has_prop = (same == 1);
    }

    bool pass = state->negated ? !has_prop : has_prop;

    if (!pass) {
        std::string msg = std::string ("Expected object to ") +
        (state->negated ? "not have " : "have ") +
        property_descriptor (*state) + " '" + prop_name + "'";
        if (value_form) {
            msg += " equal to " + js_describe (ctx, argv[1]);
        }
        return throw_expect_failure (ctx, state, msg);
    }

    if (!retargets) {
        return expect_chained (ctx, this_val);
    }
    return expect_on_property_value (ctx, state, property_value.get ());
}

// chai's `ownProperty` / `haveOwnProperty`: `.own.property` in one word. The
// flag stays set for the rest of the chain, as chai's does.
JSValue expect_own_property (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    state->own = true;
    return expect_have_property (ctx, this_val, argc, argv);
}

/**
 * `Object.<function>(...args)` as its new reference, or the exception it
 * raised. chai answers with `Object.isFrozen` and its siblings, the language's
 * own questions, so they are asked of the language: sealed or extensible is no
 * property list this file could read back.
 */
JSValue call_object_static (JSContext* ctx, const char* function, int argc, JSValueConst* argv) {
    const ScopedValue global (ctx, JS_GetGlobalObject (ctx));
    const ScopedValue object (ctx, JS_GetPropertyStr (ctx, global.get (), "Object"));
    const ScopedValue callee (ctx, JS_GetPropertyStr (ctx, object.get (), function));
    if (!JS_IsFunction (ctx, callee.get ())) {
        return JS_ThrowInternalError (ctx, "Object.%s is not available", function);
    }
    return JS_Call (ctx, callee.get (), object.get (), argc, argv);
}

/**
 * chai's `ownPropertyDescriptor(name[, descriptor])`: the target has that own
 * property and, given a descriptor, its descriptor deeply equals it. Reading it
 * retargets the chain at the descriptor, as `property` does at the value, so
 * `.ownPropertyDescriptor("a").that.has.property("writable")` asserts on it.
 * chai reads a string second argument as the failure message; Vayu has no
 * per-call message, so a string there is accepted and unread.
 */
JSValue expect_own_property_descriptor (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "ownPropertyDescriptor() requires a property name");
    }
    const bool has_descriptor = argc >= 2 && JS_IsObject (argv[1]);
    if (argc >= 2 && !has_descriptor && !JS_IsString (argv[1]) &&
    !JS_IsUndefined (argv[1]) && !JS_IsNull (argv[1])) {
        return JS_ThrowTypeError (ctx, "ownPropertyDescriptor() expects a descriptor object, got %s",
        js_type_name (ctx, argv[1]));
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    // `Object(null)` is `{}` in chai, so a null or undefined target has no
    // property rather than being a TypeError.
    JSValue read = JS_UNDEFINED;
    if (!JS_IsNull (state->actual) && !JS_IsUndefined (state->actual)) {
        std::array<JSValueConst, 2> args{ state->actual, argv[0] };
        read = call_object_static (ctx, "getOwnPropertyDescriptor",
        static_cast<int> (args.size ()), args.data ());
        if (JS_IsException (read)) {
            return JS_EXCEPTION;
        }
    }
    const ScopedValue actual_descriptor (ctx, read);
    const bool present = JS_IsObject (actual_descriptor.get ());

    bool holds = present;
    if (present && has_descriptor) {
        DeepEqualPath path;
        const int same = js_deep_equal (
        ctx, argv[1], actual_descriptor.get (), 0, path, ZeroRule::Signed);
        if (same < 0) {
            return JS_EXCEPTION;
        }
        holds = (same == 1);
    }

    const bool pass = state->negated ? !holds : holds;
    if (!pass) {
        const std::string name     = js_describe (ctx, argv[0]);
        const std::string polarity = state->negated ? "to not " : "to ";
        std::string msg;
        if (present && has_descriptor) {
            msg = "Expected the own property descriptor for " + name + " " +
            polarity + "match " + js_describe (ctx, argv[1]);
            if (!state->negated) {
                msg += ", got " + js_describe (ctx, actual_descriptor.get ());
            }
        } else {
            msg = "Expected " + js_describe (ctx, state->actual) + " " +
            polarity + "have an own property descriptor for " + name;
        }
        return throw_expect_failure (ctx, state, msg);
    }

    if (state->negated) {
        return expect_chained (ctx, this_val);
    }
    return expect_on_property_value (ctx, state, actual_descriptor.get ());
}

// Terminal getters assert on property access (the chai / Postman paren-less
// idiom): each honours `negated`, throws on failure and returns the expectation
// so the chain continues.

JSValue expect_null_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
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

    return expect_chained (ctx, this_val);
}

JSValue expect_undefined_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
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

    return expect_chained (ctx, this_val);
}

JSValue expect_ok_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
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

    return expect_chained (ctx, this_val);
}

JSValue expect_empty_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
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
        // ownKeys trap can refuse it; "not empty" for a list never produced
        // would pass under `.not`.
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

    return expect_chained (ctx, this_val);
}

/**
 * `.NaN`: chai's `value !== value`, which only a NaN number satisfies; not
 * `ToNumber(value)` is NaN, as chai fails `expect("foo").to.be.NaN` and
 * coercion would pass every non-numeric string. A getter, as chai's is, which
 * is why its absence was silent: `.to.be.NaN` on an object lacking it evaluates
 * to `undefined`.
 */
JSValue expect_nan_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
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

    return expect_chained (ctx, this_val);
}

/**
 * `.finite` - chai's `typeof value === 'number' && isFinite(value)`: strict on
 * the type, so a numeric string is not finite, and NaN and the infinities are
 * not either.
 */
JSValue expect_finite_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    double value         = 0;
    const bool is_finite = JS_IsNumber (state->actual) &&
    JS_ToFloat64 (ctx, &value, state->actual) >= 0 && std::isfinite (value);
    const bool pass = state->negated ? !is_finite : is_finite;

    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not be a finite number" : " to be a finite number");
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// The verdict of a getter that asks one yes/no question of the target: the
// failure names the target and the adjective, under `.not` as well.
JSValue assert_target_is (JSContext* ctx,
JSValueConst this_val,
const ExpectState& state,
bool holds,
const char* adjective) {
    if (state.negated == holds) {
        const std::string msg = "Expected " + js_describe (ctx, state.actual) +
        (state.negated ? " to not be " : " to be ") + adjective;
        return throw_expect_failure (ctx, &state, msg);
    }
    return expect_chained (ctx, this_val);
}

/**
 * `.arguments` / `.Arguments` - chai's `type(value) === 'Arguments'`, which is
 * the `[object Arguments]` tag of a function's own `arguments` object.
 */
JSValue expect_arguments_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    bool failed           = false;
    const std::string tag = js_class_tag (ctx, state->actual, &failed);
    if (failed) {
        return JS_EXCEPTION;
    }
    return assert_target_is (ctx, this_val, *state, tag == "[object Arguments]", "arguments");
}

// `.extensible`, `.sealed` and `.frozen` answer as `Object.isExtensible`,
// `isSealed` and `isFrozen` do, a primitive included (sealed, frozen, not
// extensible), the same calls chai takes its answer from.
struct ObjectStateMatcher {
    const char* name;
    const char* query;
};
constexpr auto object_state_matchers = std::to_array<ObjectStateMatcher> ({
{ "extensible", "isExtensible" },
{ "sealed", "isSealed" },
{ "frozen", "isFrozen" },
});

JSValue expect_object_state_getter (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)argc;
    (void)argv;
    const ObjectStateMatcher& matcher =
    object_state_matchers.at (static_cast<size_t> (magic));
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    JSValueConst target = state->actual;
    const ScopedValue answer (ctx, call_object_static (ctx, matcher.query, 1, &target));
    if (JS_IsException (answer.get ())) {
        return JS_EXCEPTION;
    }
    return assert_target_is (
    ctx, this_val, *state, JS_ToBool (ctx, answer.get ()) == 1, matcher.name);
}

// Callable matchers documented in pm-api-compatibility.md; `least` and `most`
// are `expect_ordering`'s other two arms.

JSValue expect_length (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "length() requires an argument");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const LengthSubject subject = read_length_subject (ctx, state->actual);
    if (auto refusal = length_read_refusal (ctx, *state, subject)) {
        return *refusal;
    }

    double expected = 0;
    if (JS_ToFloat64 (ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "length() requires a numeric argument");
    }

    bool matches = (subject.value == expected);
    bool pass    = state->negated ? !matches : matches;

    if (!pass) {
        std::string msg = std::string ("Expected ") + subject.descriptor + " " +
        js_describe (ctx, JS_NewFloat64 (ctx, subject.value)) +
        (state->negated ? " to not equal " : " to equal ") +
        js_describe (ctx, JS_NewFloat64 (ctx, expected));
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

/**
 * What reading a chainable method answers: its call, standing in for the
 * expectation. chai's chainable methods (`length`, `include`, `a` and their
 * spellings) are a call and the rest of the chain: `.to.have.length(3)` and
 * `.to.have.length.above(2)` are one member, as are `.to.include(1)` /
 * `.to.include.members([1])` and `.to.be.an('array')` /
 * `.to.be.an.instanceof(Array)`. The member calls @p member on the expectation
 * and has the expectation as prototype, so every other member (a matcher, a
 * flag, a language word, the unknown-member hook) is found through it and
 * `expectation_state` resolves `this` back. A fixed list of forwarded members
 * would be a second copy of the chain, missing each later member.
 */
JSValue chainable_method (JSContext* ctx, JSValueConst this_val, const ExpectMember& member) {
    ScopedValue expectation (ctx, expectation_object (ctx, this_val));
    if (JS_IsUndefined (expectation.get ())) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    JSValue chain = JS_NewObjectProtoClass (ctx, expectation.get (), expect_member_class_id);
    if (JS_IsException (chain)) {
        return chain;
    }
    JS_SetOpaque (chain, const_cast<ExpectMember*> (&member));
    return chain;
}

/**
 * The name `.a()` / `.an()` compare against: chai's `type-detect`, lowered. The
 * primitives and the three most-asked shapes keep their direct reads; anything
 * else is named by its `Object.prototype.toString` tag, as `type-detect`
 * reports it (`Date`, `RegExp`, `Map`, `Set`, `Error`, `Promise`, `Symbol`,
 * `BigInt` become `date`, `regexp`, `map`, `set`, `error`, `promise`, `symbol`,
 * `bigint`; a plain object stays `object`, #2528). Nothing, with the exception
 * pending, when reading the tag threw.
 */
std::optional<std::string> expect_type_name (JSContext* ctx, JSValueConst value) {
    if (JS_IsNull (value)) {
        return "null";
    }
    if (JS_IsUndefined (value)) {
        return "undefined";
    }
    if (JS_IsArray (value)) {
        return "array";
    }
    if (JS_IsString (value)) {
        return "string";
    }
    if (JS_IsNumber (value)) {
        return "number";
    }
    if (JS_IsBool (value)) {
        return "boolean";
    }
    if (JS_IsFunction (ctx, value)) {
        return "function";
    }

    bool failed           = false;
    const std::string tag = js_class_tag (ctx, value, &failed);
    if (failed) {
        return std::nullopt;
    }
    constexpr std::string_view prefix = "[object ";
    if (!tag.starts_with (prefix) || !tag.ends_with (']')) {
        return "object";
    }
    return vayu::utils::ascii_lower (
    tag.substr (prefix.size (), tag.size () - prefix.size () - 1));
}

JSValue expect_a (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "a() requires a type name");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const std::optional<std::string> detected = expect_type_name (ctx, state->actual);
    if (!detected) {
        return JS_EXCEPTION;
    }
    const std::string& type_name = *detected;

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

    auto* state = expectation_state (ctx, this_val);
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

// Matchers a Postman suite reaches for, each failing loudly on an argument it
// cannot use: a matcher quietly accepting anything is the false pass this
// series removes.

/**
 * Whether the target relates to one of @p candidates as the chain asks: plain
 * `oneOf` asks whether it is a candidate; after `include` / `contain`, whether
 * it contains one (a substring, an array element). 1, 0, or -1 with a pending
 * exception.
 */
int one_of_matches (JSContext* ctx, const ExpectState& state, JSValueConst candidates) {
    const std::optional<std::string> text =
    state.contains ? expect_string_like (ctx, state.actual) : std::nullopt;
    if (state.contains && !text && !JS_IsArray (state.actual)) {
        JS_ThrowTypeError (ctx,
        "oneOf() after include expects the target to be a string or an "
        "array, got %s",
        js_type_name (ctx, state.actual));
        return -1;
    }

    const uint32_t len = js_array_length (ctx, candidates);
    for (uint32_t i = 0; i < len; i++) {
        // Same rule as `include`: a candidate that could not be read is not a
        // candidate the target failed to match.
        ScopedValue candidate (ctx, JS_GetPropertyUint32 (ctx, candidates, i));
        if (JS_IsException (candidate.get ())) {
            return -1;
        }
        int same = 0;
        if (text) {
            same =
            text->find (js_to_string (ctx, candidate.get ())) != std::string::npos ? 1 : 0;
        } else if (state.contains) {
            same = array_holds (ctx, state.actual, candidate.get (), state.deep);
        } else {
            same =
            js_compare_for_chain (ctx, state.actual, candidate.get (), state.deep);
        }
        if (same != 0) {
            return same;
        }
    }
    return 0;
}

JSValue expect_one_of (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsArray (argv[0])) {
        return JS_ThrowTypeError (ctx, "oneOf() requires an array of candidates");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }

    const int found = one_of_matches (ctx, *state, argv[0]);
    if (found < 0) {
        return JS_EXCEPTION;
    }

    const bool pass = state->negated ? (found == 0) : (found == 1);
    if (!pass) {
        const char* relation = state->contains ? "contain one of " : "be one of ";
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not " : " to ") + relation + js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

/**
 * Whether the target's own enumerable keys answer the chain's question. Both
 * lists are sorted and @p expected has no duplicates. `have.keys` (and
 * `all.keys`, the default) means exactly these; after `include` / `contain`, at
 * least these; `any.keys` at least one of them, `include` or not, as in chai.
 */
bool keys_match (const ExpectState& state,
const std::vector<std::string>& actual,
const std::vector<std::string>& expected) {
    const auto held = [&actual] (const std::string& key) {
        return std::binary_search (actual.begin (), actual.end (), key);
    };
    if (state.any_key) {
        return std::any_of (expected.begin (), expected.end (), held);
    }
    if (state.contains) {
        return std::all_of (expected.begin (), expected.end (), held);
    }
    return actual == expected;
}

std::string keys_failure_message (const ExpectState& state, const std::string& listed) {
    const char* relation = "have exactly the keys ";
    if (state.any_key) {
        relation = "have any of the keys ";
    } else if (state.contains) {
        relation = "contain the keys ";
    }
    return std::string ("Expected object to ") + (state.negated ? "not " : "") +
    relation + listed;
}

// The keys `keys` was asked about, as a new array: one array argument's
// elements, or every argument.
JSValue key_argument_list (JSContext* ctx, int argc, JSValueConst* argv) {
    if (argc == 1 && JS_IsArray (argv[0])) {
        return JS_DupValue (ctx, argv[0]);
    }
    JSValue list = JS_NewArray (ctx);
    for (int i = 0; i < argc && !JS_IsException (list); i++) {
        if (JS_SetPropertyUint32 (ctx, list, static_cast<uint32_t> (i),
            JS_DupValue (ctx, argv[i])) < 0) {
            JS_FreeValue (ctx, list);
            return JS_EXCEPTION;
        }
    }
    return list;
}

// What `keys` decided: 1, 0, or -1 with a pending exception, and the keys it
// was asked about as its failure names them.
struct KeysAnswer {
    int matched = -1;
    std::string listed{};
};

/**
 * The names an object target's `keys` is asked about, each a string. One
 * plain-object argument stands for its own enumerable keys (chai's
 * `Object.keys` of it); otherwise `key_argument_list`'s. An unreadable name is
 * no name: `js_to_string` would answer "", compared against the real keys as
 * though asked for. False with a pending exception.
 */
bool read_key_names (JSContext* ctx, int argc, JSValueConst* argv, std::vector<std::string>& out) {
    if (argc == 1 && JS_IsObject (argv[0]) && !JS_IsArray (argv[0])) {
        bool tag_failed       = false;
        const std::string tag = js_class_tag (ctx, argv[0], &tag_failed);
        if (tag_failed) {
            return false;
        }
        if (tag == "[object Object]") {
            return js_own_enumerable_keys (ctx, argv[0], out);
        }
    }
    const ScopedValue list (ctx, key_argument_list (ctx, argc, argv));
    if (JS_IsException (list.get ())) {
        return false;
    }
    const uint32_t len = js_array_length (ctx, list.get ());
    for (uint32_t i = 0; i < len; i++) {
        const ScopedValue key (ctx, JS_GetPropertyUint32 (ctx, list.get (), i));
        if (JS_IsException (key.get ())) {
            return false;
        }
        out.push_back (js_to_string (ctx, key.get ()));
    }
    return true;
}

// chai's "keys required": an empty list would make `include.keys([])` pass for
// every target, asserting nothing.
int refuse_empty_keys (JSContext* ctx) {
    JS_ThrowTypeError (ctx, "keys() requires at least one key name");
    return -1;
}

// `keys` on anything but a Map or a Set compares own enumerable key names.
KeysAnswer
object_keys_answer (JSContext* ctx, const ExpectState& state, int argc, JSValueConst* argv) {
    std::vector<std::string> expected;
    if (!read_key_names (ctx, argc, argv, expected)) {
        return {};
    }
    if (expected.empty ()) {
        return { refuse_empty_keys (ctx) };
    }
    std::sort (expected.begin (), expected.end ());
    expected.erase (std::unique (expected.begin (), expected.end ()), expected.end ());

    std::vector<std::string> actual_keys;
    if (!js_own_enumerable_keys (ctx, state.actual, actual_keys)) {
        return {};
    }
    std::sort (actual_keys.begin (), actual_keys.end ());

    KeysAnswer answer{ keys_match (state, actual_keys, expected) ? 1 : 0 };
    for (const auto& key : expected) {
        answer.listed += (answer.listed.empty () ? "'" : ", '") + key + "'";
    }
    return answer;
}

/**
 * Whether @p held, a Map's keys or a Set's members, answers `keys` for
 * @p wanted: 1, 0, or -1 with a pending exception. chai compares the values,
 * never their strings (`===`, or deep-eql under `deep`), so `new Map([[1, 1]])`
 * has the key `1`, not `'1'`; exactness counts the list as given, without
 * de-duplicating.
 */
int collection_keys_match (JSContext* ctx, const ExpectState& state, JSValueConst held, JSValueConst wanted) {
    const uint32_t wanted_len = js_array_length (ctx, wanted);
    const bool exact          = !state.any_key && !state.contains;
    if (exact && wanted_len != js_array_length (ctx, held)) {
        return 0;
    }
    for (uint32_t i = 0; i < wanted_len; i++) {
        const ScopedValue want (ctx, JS_GetPropertyUint32 (ctx, wanted, i));
        if (JS_IsException (want.get ())) {
            return -1;
        }
        const int found = array_holds (ctx, held, want.get (), state.deep);
        if (found < 0 || (state.any_key && found == 1)) {
            return found;
        }
        if (!state.any_key && found == 0) {
            return 0;
        }
    }
    return state.any_key ? 0 : 1;
}

KeysAnswer
collection_keys_answer (JSContext* ctx, const ExpectState& state, int argc, JSValueConst* argv) {
    const ScopedValue wanted (ctx, key_argument_list (ctx, argc, argv));
    if (JS_IsException (wanted.get ())) {
        return {};
    }
    const uint32_t wanted_len = js_array_length (ctx, wanted.get ());
    if (wanted_len == 0) {
        return { refuse_empty_keys (ctx) };
    }
    KeysAnswer answer;
    for (uint32_t i = 0; i < wanted_len; i++) {
        const ScopedValue want (ctx, JS_GetPropertyUint32 (ctx, wanted.get (), i));
        if (JS_IsException (want.get ())) {
            return {};
        }
        answer.listed += (i == 0 ? "" : ", ") + js_describe (ctx, want.get ());
    }
    const ScopedValue held (ctx, collection_contents (ctx, state.actual, "keys"));
    if (JS_IsException (held.get ())) {
        return {};
    }
    answer.matched = collection_keys_match (ctx, state, held.get (), wanted.get ());
    return answer;
}

JSValue expect_keys (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "keys() requires at least one key name");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsObject (state->actual)) {
        return JS_ThrowTypeError (ctx, "keys() requires an object or array");
    }

    bool tag_failed       = false;
    const std::string tag = js_class_tag (ctx, state->actual, &tag_failed);
    if (tag_failed) {
        return JS_EXCEPTION;
    }
    const KeysAnswer answer = (tag == "[object Map]" || tag == "[object Set]") ?
    collection_keys_answer (ctx, *state, argc, argv) :
    object_keys_answer (ctx, *state, argc, argv);
    if (answer.matched < 0) {
        return JS_EXCEPTION;
    }

    const bool matches = answer.matched == 1;
    const bool pass    = state->negated ? !matches : matches;
    if (!pass) {
        return throw_expect_failure (
        ctx, state, keys_failure_message (*state, answer.listed));
    }

    return expect_chained (ctx, this_val);
}

// `ordered.members`: element i of @p wanted equals element i of the target.
// Without `contains` the lengths must agree too; with it @p wanted is a prefix.
int ordered_members_match (JSContext* ctx, const ExpectState& state, JSValueConst wanted) {
    const uint32_t actual_len = js_array_length (ctx, state.actual);
    const uint32_t wanted_len = js_array_length (ctx, wanted);
    if (wanted_len > actual_len || (!state.contains && wanted_len != actual_len)) {
        return 0;
    }
    for (uint32_t i = 0; i < wanted_len; i++) {
        // Same rule as `include`: an element that could not be read is not an
        // element that failed to pair.
        ScopedValue want (ctx, JS_GetPropertyUint32 (ctx, wanted, i));
        if (JS_IsException (want.get ())) {
            return -1;
        }
        ScopedValue held (ctx, JS_GetPropertyUint32 (ctx, state.actual, i));
        if (JS_IsException (held.get ())) {
            return -1;
        }
        const int same =
        js_compare_for_chain (ctx, held.get (), want.get (), state.deep);
        if (same != 1) {
            return same;
        }
    }
    return 1;
}

// `members` in any order. Without `contains`, each wanted element pairs with an
// unused target element, so duplicates match in count and lengths agree; with
// it each need only be present, chai's `isSubsetOf`, which is why
// `[1, 2].include.members([1, 1])` holds.
int unordered_members_match (JSContext* ctx, const ExpectState& state, JSValueConst wanted) {
    const uint32_t actual_len = js_array_length (ctx, state.actual);
    const uint32_t wanted_len = js_array_length (ctx, wanted);
    if (!state.contains && wanted_len != actual_len) {
        return 0;
    }
    std::vector<bool> claimed (actual_len, false);
    for (uint32_t i = 0; i < wanted_len; i++) {
        ScopedValue want (ctx, JS_GetPropertyUint32 (ctx, wanted, i));
        if (JS_IsException (want.get ())) {
            return -1;
        }
        bool paired = false;
        for (uint32_t j = 0; j < actual_len && !paired; j++) {
            if (claimed[j]) {
                continue;
            }
            ScopedValue candidate (ctx, JS_GetPropertyUint32 (ctx, state.actual, j));
            if (JS_IsException (candidate.get ())) {
                return -1;
            }
            const int same =
            js_compare_for_chain (ctx, candidate.get (), want.get (), state.deep);
            if (same < 0) {
                return -1;
            }
            paired     = (same == 1);
            claimed[j] = paired && !state.contains;
        }
        if (!paired) {
            return 0;
        }
    }
    return 1;
}

// 1 when the target's members are what @p wanted asks by the chain's flags, 0
// when not, -1 with a pending exception.
int members_match (JSContext* ctx, const ExpectState& state, JSValueConst wanted) {
    return state.ordered ? ordered_members_match (ctx, state, wanted) :
                           unordered_members_match (ctx, state, wanted);
}

// chai's wording, which says whether a superset was enough and whether order
// was part of the question.
const char* members_relation (const ExpectState& state) {
    if (state.contains) {
        return state.ordered ? "be an ordered superset of" : "be a superset of";
    }
    return state.ordered ? "have ordered members" : "have members";
}

JSValue expect_members (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsArray (argv[0])) {
        return JS_ThrowTypeError (ctx, "members() requires an array");
    }

    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    // chai asserts the target's type first, as an assertion of its own, so a
    // `.not` cannot turn a non-array into a pass.
    if (!JS_IsArray (state->actual)) {
        return throw_expect_failure (ctx, state,
        "Expected " + js_describe (ctx, state->actual) + " to be an array");
    }

    const int matched = members_match (ctx, *state, argv[0]);
    if (matched < 0) {
        return JS_EXCEPTION;
    }

    const bool pass = state->negated ? (matched == 0) : (matched == 1);
    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not " : " to ") + members_relation (*state) +
        " " + js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }

    return expect_chained (ctx, this_val);
}

// What chai matches a string or regex against: an `Error`'s `message`, or the
// thrown value itself when it is no Error. `String(err)` is "TypeError: bad
// input", name included, so comparing it would pass `.to.throw("Error")` for
// every Error and `.to.throw("TypeError")` on a message merely mentioning it.
std::string thrown_message (JSContext* ctx, JSValueConst error) {
    if (JS_IsObject (error)) {
        ScopedValue message (ctx, JS_GetPropertyStr (ctx, error, "message"));
        if (JS_IsString (message.get ())) {
            return js_to_string (ctx, message.get ());
        }
    }
    // A thrown string is its own message and anything else has none (chai's
    // `check-error.getMessage`); stringifying would pass `.to.throw("4")` on
    // `throw 42`.
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
    auto* state = expectation_state (ctx, this_val);
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
    // A target that ran past the script's deadline did not throw: the engine
    // stopped it, and the pending exception is the abort. Propagate it, as
    // every surface does; a satisfied `.throw()` would be a green verdict on a
    // function that never returned.
    if (threw && script_deadline_expired (ctx)) {
        return JS_EXCEPTION;
    }
    ScopedValue thrown (ctx, threw ? JS_GetException (ctx) : JS_UNDEFINED);
    const std::string message =
    threw ? thrown_message (ctx, thrown.get ()) : std::string ();

    bool matches      = threw;
    int matcher_index = 0;
    // A function argument is the constructor the throw must be an instance of,
    // with an optional message matcher after it:
    // `expect(fn).to.throw(TypeError)` is ordinary chai, and what imported
    // scripts carry.
    if (threw && argc >= 1 && JS_IsFunction (ctx, argv[0])) {
        const int is_instance = JS_IsInstanceOf (ctx, thrown.get (), argv[0]);
        if (is_instance < 0) {
            return JS_EXCEPTION;
        }
        matches       = (is_instance == 1);
        matcher_index = 1;
    }

    // The message matcher, alone or after a constructor; a second argument is
    // read, not dropped: a script stating the message means it checked.
    if (matches && argc > matcher_index && !JS_IsUndefined (argv[matcher_index])) {
        const int matched = matches_thrown_message (ctx, argv[matcher_index], message);
        if (matched < 0) {
            return JS_EXCEPTION;
        }
        matches = (matched == 1);
    }

    const bool pass = state->negated ? !matches : matches;
    if (!pass) {
        // The message names what was expected: with an argument the bare form
        // contradicts itself ("expected the function to throw, but it threw
        // RangeError: bad" reads as an engine fault when the named constructor
        // failed).
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

    auto* state = expectation_state (ctx, this_val);
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

    auto* state = expectation_state (ctx, this_val);
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

    auto* state = expectation_state (ctx, this_val);
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

    auto* state = expectation_state (ctx, this_val);
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

/**
 * chai's `respondTo(method)`: the target has a method of that name. A function
 * target is asked about its `prototype`'s methods - what its instances respond
 * to - unless `.itself` came first, which asks about the function's own.
 */
JSValue expect_respond_to (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "respondTo() requires a method name");
    }
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsObject (state->actual)) {
        return JS_ThrowTypeError (ctx,
        "respondTo() requires the target to be an object or a function, got %s",
        js_type_name (ctx, state->actual));
    }

    // chai reads `fn.prototype[method]`, a TypeError on a function with no
    // prototype (an arrow function); "does not respond" would pass
    // `.not.respondTo` for it.
    const bool through_prototype = JS_IsFunction (ctx, state->actual) && !state->itself;
    const ScopedValue prototype (ctx,
    through_prototype ? JS_GetPropertyStr (ctx, state->actual, "prototype") : JS_UNDEFINED);
    JSValueConst holder = state->actual;
    if (through_prototype) {
        if (JS_IsException (prototype.get ())) {
            return JS_EXCEPTION;
        }
        if (!JS_IsObject (prototype.get ())) {
            return JS_ThrowTypeError (ctx,
            "respondTo() cannot read the prototype of a function that has "
            "none; "
            "use .itself to ask about the function's own members");
        }
        holder = prototype.get ();
    }

    const ScopedValue method (
    ctx, JS_GetPropertyStr (ctx, holder, js_to_string (ctx, argv[0]).c_str ()));
    if (JS_IsException (method.get ())) {
        return JS_EXCEPTION;
    }
    const bool responds = JS_IsFunction (ctx, method.get ());
    const bool pass     = state->negated ? !responds : responds;
    if (!pass) {
        const std::string msg = "Expected " + js_describe (ctx, state->actual) +
        (state->negated ? " to not respond to " : " to respond to ") +
        js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }
    return expect_chained (ctx, this_val);
}

// `change`, `increase` and `decrease` differ in one verdict and one word, so
// they are one function reached by magic, like the ordering matchers.
struct DeltaMatcher {
    const char* name;
    DeltaBehavior behavior;
};
constexpr auto delta_matchers = std::to_array<DeltaMatcher> ({
{ "change", DeltaBehavior::Change },
{ "changes", DeltaBehavior::Change },
{ "increase", DeltaBehavior::Increase },
{ "increases", DeltaBehavior::Increase },
{ "decrease", DeltaBehavior::Decrease },
{ "decreases", DeltaBehavior::Decrease },
});

const char* delta_verb (DeltaBehavior behavior) {
    switch (behavior) {
    case DeltaBehavior::Change: return "change";
    case DeltaBehavior::Increase: return "increase";
    case DeltaBehavior::Decrease: return "decrease";
    }
    return "change";
}

// What a delta matcher measures: `subject()` when no property is named,
// `subject[property]` when one is. The exception sentinel when the read threw.
JSValue read_delta_subject (JSContext* ctx, JSValueConst subject, const std::string* property) {
    if (property == nullptr) {
        return JS_Call (ctx, subject, JS_UNDEFINED, 0, nullptr);
    }
    return JS_GetPropertyStr (ctx, subject, property->c_str ());
}

// Only a number measures: chai subtracts, coercing a numeric string, and a
// non-number is NaN here, so `.by` on it fails rather than passes.
double delta_number (JSContext* ctx, JSValueConst value) {
    double out = std::nan ("");
    if (JS_IsNumber (value)) {
        JS_ToFloat64 (ctx, &out, value);
    }
    return out;
}

bool delta_holds (const DeltaRecord& record, bool values_differ) {
    switch (record.behavior) {
    case DeltaBehavior::Change: return values_differ;
    case DeltaBehavior::Increase: return record.after - record.initial > 0;
    case DeltaBehavior::Decrease: return record.after - record.initial < 0;
    }
    return false;
}

/**
 * chai's `change` / `increase` / `decrease`: calls the target and compares what
 * a subject (a function, or an object and one property's name) answers before
 * and after, keeping the measurement for a following `.by`. The target runs
 * once, between two reads of the subject, so `.by` re-reads nothing.
 */
JSValue expect_delta (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    const DeltaMatcher& matcher = delta_matchers.at (static_cast<size_t> (magic));
    if (argc < 1) {
        return JS_ThrowTypeError (ctx,
        "%s() requires a function, or an object and a property name", matcher.name);
    }
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!JS_IsFunction (ctx, state->actual)) {
        return JS_ThrowTypeError (
        ctx, "%s() requires the target to be a function", matcher.name);
    }

    // chai takes a falsy second argument to mean "no property".
    const bool by_property = argc >= 2 && JS_ToBool (ctx, argv[1]) > 0;
    const std::string property =
    by_property ? js_to_string (ctx, argv[1]) : std::string{};
    const std::string* property_name = by_property ? &property : nullptr;
    if (by_property) {
        const JSAtom atom = JS_NewAtom (ctx, property.c_str ());
        const int has_prop =
        JS_IsObject (argv[0]) ? JS_HasProperty (ctx, argv[0], atom) : 0;
        JS_FreeAtom (ctx, atom);
        if (has_prop < 0) {
            return JS_EXCEPTION;
        }
        if (has_prop == 0) {
            return JS_ThrowTypeError (ctx,
            "%s() requires the subject to be an object with a '%s' property",
            matcher.name, property.c_str ());
        }
    } else if (!JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "%s() with one argument requires a function, got %s",
        matcher.name, js_type_name (ctx, argv[0]));
    }

    const ScopedValue before (ctx, read_delta_subject (ctx, argv[0], property_name));
    if (JS_IsException (before.get ())) {
        return JS_EXCEPTION;
    }
    if (matcher.behavior != DeltaBehavior::Change && !JS_IsNumber (before.get ())) {
        return JS_ThrowTypeError (ctx, "%s() requires the subject to be a number, got %s",
        matcher.name, js_type_name (ctx, before.get ()));
    }
    const ScopedValue ran (ctx, JS_Call (ctx, state->actual, JS_UNDEFINED, 0, nullptr));
    if (JS_IsException (ran.get ())) {
        return JS_EXCEPTION;
    }
    const ScopedValue after (ctx, read_delta_subject (ctx, argv[0], property_name));
    if (JS_IsException (after.get ())) {
        return JS_EXCEPTION;
    }

    DeltaRecord record;
    record.behavior = matcher.behavior;
    record.subject = by_property ? "." + property : js_describe (ctx, before.get ());
    record.initial = delta_number (ctx, before.get ());
    record.after   = delta_number (ctx, after.get ());
    const bool values_differ = !js_strict_equal (ctx, before.get (), after.get ());
    switch (matcher.behavior) {
    case DeltaBehavior::Change:
        record.real_delta = values_differ ? 1 : 0;
        break;
    case DeltaBehavior::Increase:
        record.real_delta = record.after - record.initial;
        break;
    case DeltaBehavior::Decrease:
        record.real_delta = record.initial - record.after;
        break;
    }

    const bool holds          = delta_holds (record, values_differ);
    const std::string verb    = delta_verb (record.behavior);
    const std::string subject = record.subject;
    state->delta              = std::move (record);
    if (state->negated == holds) {
        return throw_expect_failure (ctx, state,
        "Expected " + subject + (state->negated ? " to not " : " to ") + verb);
    }
    return expect_chained (ctx, this_val);
}

/**
 * chai's `by(delta)`: how much the subject of the `change` / `increase` /
 * `decrease` before it moved. `change` counts the size of the move in either
 * direction; the other two count the move in their own.
 */
JSValue expect_by (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsNumber (argv[0])) {
        return JS_ThrowTypeError (ctx, "by() requires a number");
    }
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (!state->delta) {
        return JS_ThrowTypeError (
        ctx, "by() must follow change, increase or decrease in the chain");
    }

    const DeltaRecord& record = *state->delta;
    double wanted             = 0;
    JS_ToFloat64 (ctx, &wanted, argv[0]);
    wanted                = std::fabs (wanted);
    const double measured = record.behavior == DeltaBehavior::Change ?
    std::fabs (record.after - record.initial) :
    record.real_delta;

    const bool holds = measured == wanted;
    if (state->negated == holds) {
        const std::string msg = "Expected " + record.subject +
        (state->negated ? " to not " : " to ") + delta_verb (record.behavior) +
        " by " + js_describe (ctx, argv[0]);
        return throw_expect_failure (ctx, state, msg);
    }
    return expect_chained (ctx, this_val);
}

// chai-postman's `jsonSchema(schema, options)`. `options` is ajv's and is not
// read: the validator here is valijson (see `json_schema_failure`).
JSValue expect_json_schema (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "jsonSchema() requires a schema");
    }
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    const auto failure = json_schema_failure (ctx, state->actual, argv[0], state->negated);
    if (!failure) {
        return JS_EXCEPTION;
    }
    if (!failure->empty ()) {
        return throw_expect_failure (ctx, state, *failure);
    }
    return expect_chained (ctx, this_val);
}

// What `response_measure_chain` measures, indexed by `ResponseMeasure`.
constexpr auto response_measure_nouns =
std::to_array<const char*> ({ "response time", "response size" });

/**
 * The call half of `responseTime` / `responseSize`: chai-postman's two checks
 * in order, the measure is a number, then it equals the argument. The first
 * always holds, so under `not` the call fails whatever it is given, Postman's
 * verdict, kept rather than read as "not equal", which would pass an assertion
 * Postman fails.
 */
JSValue
response_measure_call (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    const char* noun = response_measure_nouns.at (static_cast<size_t> (magic));
    if (state->negated) {
        return throw_expect_failure (ctx, state,
        std::format ("Expected response to not have a valid {}", noun));
    }
    if (argc < 1) {
        return expect_chained (ctx, this_val);
    }
    DeepEqualPath path;
    const int same =
    js_deep_equal (ctx, state->actual, argv[0], 0, path, ZeroRule::SameValueZero);
    if (same < 0) {
        return JS_EXCEPTION;
    }
    if (same == 0) {
        return throw_expect_failure (ctx, state,
        std::format ("Expected {} {} to equal {}", noun,
        js_describe (ctx, state->actual), js_describe (ctx, argv[0])));
    }
    return expect_chained (ctx, this_val);
}

// `responseTime` / `responseSize` as chainable methods, indexed by
// `ResponseMeasure`. Unnamed: the expectation's path already ends with them.
constexpr auto response_measure_members = std::to_array<ExpectMember> ({
{ "", response_measure_call, static_cast<int> (ResponseMeasure::Time), 1, MemberShape::Chainable },
{ "", response_measure_call, static_cast<int> (ResponseMeasure::Size), 1, MemberShape::Chainable },
});

// The chain each measure starts, by `ResponseMeasure` and then polarity, so an
// unknown member after one names `pm.response.to.have.responseTime`.
constexpr std::array<std::array<const char*, 2>, 2> response_measure_paths = { {
{ "pm.response.to.have.responseTime", "pm.response.to.not.have.responseTime" },
{ "pm.response.to.have.responseSize", "pm.response.to.not.have.responseSize" },
} };

// A matcher written without a magic, as a member's call.
template <JSCFunction* matcher>
JSValue
without_magic (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)magic;
    return matcher (ctx, this_val, argc, argv);
}

template <JSCFunction* matcher>
constexpr ExpectMember matcher_member (const char* name, int length) {
    return { name, without_magic<matcher>, 0, length, MemberShape::Method };
}

// The rows of a magic-indexed matcher table (`ordering_matchers`,
// `delta_matchers`) as members, each calling @p call with its row's index.
template <typename Row, size_t N>
constexpr std::array<ExpectMember, N>
magic_matchers (const std::array<Row, N>& rows, JSCFunctionMagic* call, int length) {
    std::array<ExpectMember, N> members{};
    for (size_t row = 0; row < N; row++) {
        members.at (row) = { rows.at (row).name, call, static_cast<int> (row),
            length, MemberShape::Method };
    }
    return members;
}

// The matchers called as `.equal(v)`. `equal` and `eql` are separate on
// purpose: chai's `equal` is `===` (reference identity) and `eql` deep, so
// aliasing them passes assertions Postman fails.
constexpr auto matcher_members = std::to_array<ExpectMember> ({
matcher_member<expect_equal> ("equal", 1),
matcher_member<expect_equal> ("eq", 1),
matcher_member<expect_equal> ("equals", 1),
matcher_member<expect_eql> ("eql", 1),
matcher_member<expect_eql> ("eqls", 1),
matcher_member<expect_one_of> ("oneOf", 1),
matcher_member<expect_keys> ("keys", 1),
matcher_member<expect_keys> ("key", 1),
matcher_member<expect_members> ("members", 1),
matcher_member<expect_throw> ("throw", 1),
matcher_member<expect_throw> ("throws", 1),
matcher_member<expect_throw> ("Throw", 1),
matcher_member<expect_instance_of> ("instanceOf", 1),
matcher_member<expect_instance_of> ("instanceof", 1),
matcher_member<expect_close_to> ("closeTo", 2),
matcher_member<expect_close_to> ("approximately", 2),
matcher_member<expect_satisfy> ("satisfy", 1),
matcher_member<expect_satisfy> ("satisfies", 1),
matcher_member<expect_string> ("string", 1),
matcher_member<expect_match> ("match", 1),
matcher_member<expect_match> ("matches", 1),
matcher_member<expect_have_property> ("property", 2),
matcher_member<expect_own_property> ("ownProperty", 2),
matcher_member<expect_own_property> ("haveOwnProperty", 2),
matcher_member<expect_own_property_descriptor> ("ownPropertyDescriptor", 2),
matcher_member<expect_own_property_descriptor> ("haveOwnPropertyDescriptor", 2),
matcher_member<expect_respond_to> ("respondTo", 1),
matcher_member<expect_respond_to> ("respondsTo", 1),
matcher_member<expect_by> ("by", 1),
matcher_member<expect_json_schema> ("jsonSchema", 1),
});
constexpr auto ordering_members = magic_matchers (ordering_matchers, expect_ordering, 1);
constexpr auto delta_members = magic_matchers (delta_matchers, expect_delta, 2);

// chai's chainable methods, and the flag reading one sets (none for `a`).
// `length` / `lengthOf` set `doLength`, so the ordering matchers compare the
// length; `include` / `contain` / `includes` / `contains` set `contains`, so
// `.include.keys` and `.include.members` accept a superset and `.contain.oneOf`
// asks whether the target contains a candidate. The read sets the flag, not the
// call, so it holds for the rest of the chain as in chai.
struct ChainableMember {
    ExpectMember member;
    bool ExpectState::* flag;
};
constexpr auto chainable_members = std::to_array<ChainableMember> ({
{ { "length", without_magic<expect_length>, 0, 1, MemberShape::Chainable }, &ExpectState::do_length },
{ { "lengthOf", without_magic<expect_length>, 0, 1, MemberShape::Chainable }, &ExpectState::do_length },
{ { "include", without_magic<expect_include>, 0, 1, MemberShape::Chainable }, &ExpectState::contains },
{ { "contain", without_magic<expect_include>, 0, 1, MemberShape::Chainable }, &ExpectState::contains },
{ { "includes", without_magic<expect_include>, 0, 1, MemberShape::Chainable }, &ExpectState::contains },
{ { "contains", without_magic<expect_include>, 0, 1, MemberShape::Chainable }, &ExpectState::contains },
{ { "a", without_magic<expect_a>, 0, 1, MemberShape::Chainable }, nullptr },
{ { "an", without_magic<expect_a>, 0, 1, MemberShape::Chainable }, nullptr },
});

constexpr bool within_arity_limit (const ExpectMember& member) {
    return member.length <= MEMBER_ARITY_LIMIT;
}
static_assert (std::ranges::all_of (matcher_members, within_arity_limit) &&
std::ranges::all_of (ordering_members, within_arity_limit) &&
std::ranges::all_of (delta_members, within_arity_limit) &&
std::ranges::all_of (response_measure_members, within_arity_limit) &&
std::ranges::all_of (chainable_members,
[] (const ChainableMember& row) { return within_arity_limit (row.member); }),
"expect_member_call pads argv into MEMBER_ARITY_LIMIT slots");

// The getter of a chainable method; the magic is its row.
JSValue expect_chainable_getter (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)argc;
    (void)argv;
    const ChainableMember& row = chainable_members.at (static_cast<size_t> (magic));
    auto* state = expectation_state (ctx, this_val);
    if (!state) {
        return JS_ThrowInternalError (ctx, "Invalid expectation state");
    }
    if (row.flag != nullptr) {
        state->*row.flag = true;
    }
    return chainable_method (ctx, this_val, row.member);
}

bool install_matchers (JSContext* ctx, JSValueConst obj, std::span<const ExpectMember> members) {
    for (const ExpectMember& member : members) {
        JSValue matcher = JS_NewObjectClass (ctx, expect_member_class_id);
        if (JS_IsException (matcher)) {
            return false;
        }
        JS_SetOpaque (matcher, const_cast<ExpectMember*> (&member));
        if (JS_DefinePropertyValueStr (ctx, obj, member.name, matcher, JS_PROP_C_W_E) < 0) {
            return false;
        }
    }
    return true;
}

JSValue create_expectation (JSContext* ctx, JSValue actual, std::string message) {
    JSValue obj = JS_NewObjectClass (ctx, expect_class_id);
    if (JS_IsException (obj)) {
        return obj;
    }

    auto* state    = new ExpectState{ JS_DupValue (ctx, actual), false };
    state->message = std::move (message);
    JS_SetOpaque (obj, state);

    JSAtom to_atom = JS_NewAtom (ctx, "to");
    JS_DefinePropertyGetSet (ctx, obj, to_atom,
    JS_NewCFunction (ctx, expect_to_getter, "to", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, to_atom);

    JSAtom not_atom = JS_NewAtom (ctx, "not");
    JS_DefinePropertyGetSet (ctx, obj, not_atom,
    JS_NewCFunction (ctx, expect_not_getter, "not", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, not_atom);

    JSAtom be_atom = JS_NewAtom (ctx, "be");
    JS_DefinePropertyGetSet (ctx, obj, be_atom,
    JS_NewCFunction (ctx, expect_be_getter, "be", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, be_atom);

    // "have" is "to" again.
    JSAtom have_atom = JS_NewAtom (ctx, "have");
    JS_DefinePropertyGetSet (ctx, obj, have_atom,
    JS_NewCFunction (ctx, expect_to_getter, "have", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, have_atom);

    // "at", for `.at.least(n)` / `.at.most(n)`.
    JSAtom at_atom = JS_NewAtom (ctx, "at");
    JS_DefinePropertyGetSet (ctx, obj, at_atom,
    JS_NewCFunction (ctx, expect_to_getter, "at", 0), JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, at_atom);

    // Passthrough chainers. "and" continues a chain after a matcher (why every
    // matcher returns the expectation). The rest are chai's language chains
    // (#1053), asserting nothing so a chain reads as English
    // (`expect(rows).to.be.an('array').that.is.not.empty`); without them a
    // fluent imported collection fails on the language, as the unknown-member
    // hook (#999) throws on each word. Each hands back the expectation, so the
    // chain's flags, `not` included, carry across as for `and`. `all`, `any`,
    // `own`, `ordered` and `itself` look like prose but change what a later
    // matcher asserts, so they are flags below.
    const char* passthrough_chainers[] = { "and", "also", "been", "but", "does",
        "has", "is", "of", "same", "still", "that", "which", "with" };
    for (const char* name : passthrough_chainers) {
        JSAtom atom = JS_NewAtom (ctx, name);
        JS_DefinePropertyGetSet (ctx, obj, atom,
        JS_NewCFunction (ctx, expect_to_getter, name, 0), JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    }

    int flag_magic = 0;
    for (const auto& chainer : flag_chainers) {
        JSAtom atom = JS_NewAtom (ctx, chainer.name);
        JS_DefinePropertyGetSet (ctx, obj, atom,
        JS_NewCFunctionMagic (ctx, expect_flag_getter, chainer.name, 0,
        JS_CFUNC_generic_magic, flag_magic),
        JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
        flag_magic++;
    }

    // chai's chainable methods: reading one sets its flag and answers both the
    // call and the start of the chain. See `chainable_method`.
    for (size_t row = 0; row < chainable_members.size (); row++) {
        const char* name = chainable_members.at (row).member.name;
        JSAtom atom      = JS_NewAtom (ctx, name);
        JS_DefinePropertyGetSet (ctx, obj, atom,
        JS_NewCFunctionMagic (ctx, expect_chainable_getter, name, 0,
        JS_CFUNC_generic_magic, static_cast<int> (row)),
        JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    }

    // Terminal matchers assert on access (the chai / Postman paren-less idiom),
    // so they are getters, not function-valued properties: a bare `.to.be.true`
    // must run the check, not return an uncalled function.
    struct TerminalGetter {
        const char* name;
        JSCFunction* fn;
    };
    const TerminalGetter terminals[] = { { "exist", expect_exist },
        { "true", expect_true }, { "false", expect_false },
        { "null", expect_null_getter }, { "undefined", expect_undefined_getter },
        { "ok", expect_ok_getter }, { "empty", expect_empty_getter },
        { "NaN", expect_nan_getter }, { "finite", expect_finite_getter },
        { "exists", expect_exist }, { "arguments", expect_arguments_getter },
        { "Arguments", expect_arguments_getter } };
    for (const auto& t : terminals) {
        JSAtom atom = JS_NewAtom (ctx, t.name);
        JS_DefinePropertyGetSet (
        ctx, obj, atom, JS_NewCFunction (ctx, t.fn, t.name, 0), JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    }

    for (size_t row = 0; row < object_state_matchers.size (); row++) {
        const char* name = object_state_matchers.at (row).name;
        JSAtom atom      = JS_NewAtom (ctx, name);
        JS_DefinePropertyGetSet (ctx, obj, atom,
        JS_NewCFunctionMagic (ctx, expect_object_state_getter, name, 0,
        JS_CFUNC_generic_magic, static_cast<int> (row)),
        JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    }

    if (!install_matchers (ctx, obj, matcher_members) ||
    !install_matchers (ctx, obj, ordering_members) ||
    !install_matchers (ctx, obj, delta_members)) {
        JS_FreeValue (ctx, obj);
        return JS_EXCEPTION;
    }

    // Last, once every member above is in place: from here a name this object
    // does not carry is a throw rather than `undefined`.
    state->armed = true;
    return obj;
}

// ============================================================================
// pm.test, pm.expect and pm.expect.fail
// ============================================================================

// The three fields a done-style test reports through, on a plain JS object
// rather than a C++ struct on `js_pm_test`'s frame: a script can keep `done`
// and call it after `pm.test` returned (later in the script, or from a promise
// job the drain runs after). Bound to a stack pointer that is a use-after-free;
// bound to a collector-owned object it is a write nobody reads.
constexpr const char* DONE_CALLED  = "called";
constexpr const char* DONE_FAILED  = "failed";
constexpr const char* DONE_MESSAGE = "message";

/**
 * The `done` a test callback declaring a parameter gets. Mocha's contract,
 * which postman-sandbox follows: no (or a falsy) argument completes the test,
 * any truthy one fails it, an `Error` being the documented shape, reported as
 * the throw path reports a thrown one so both read alike (a truthy value never
 * reaches `thrown_value_message`'s null and undefined wording). A second call
 * is refused rather than overwriting the first verdict: called twice inside the
 * callback it throws, failing the test by name, as Postman does.
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
 * Whether @p callback declares a parameter, so it wants a `done`:
 * postman-sandbox reads `fn.length` for this, and the two forms report their
 * verdict differently, so the arity is asked before the call, not inferred.
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
 * Records what a done-style callback left on @p state, only when it returned
 * without throwing: a throw is already the verdict, and a test that threw
 * before its `done()` is not also an asynchronous-completion mistake.
 */
void apply_done_verdict (JSContext* ctx, JSValueConst state, TestResult& result) {
    JSValue called        = JS_GetPropertyStr (ctx, state, DONE_CALLED);
    const bool was_called = JS_ToBool (ctx, called) > 0;
    JS_FreeValue (ctx, called);

    if (!was_called) {
        // Postman waits here; this sandbox does not. The verdict is taken when
        // the callback returns, and a `done()` left for later (a `.then`, after
        // an `await`) runs only when the job queue drains, after the row was
        // written. Saying so is the honest outcome.
        result.passed = false;
        result.error_message =
        "done() was never called before the callback returned. A done-style "
        "test is judged when its callback returns, so a done() left for later "
        "(in a .then, or after an await) is not waited for - call done() "
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

    // A callback declaring a parameter asks for the done-style form; one that
    // does not is called as before.
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

    const AllocationRefusalWatch refusal_watch (ctx);
    JSValue ret = JS_Call (
    ctx, argv[1], JS_UNDEFINED, arity > 0 ? 1 : 0, arity > 0 ? &done : nullptr);

    if (JS_IsException (ret)) {
        JSValue exc          = JS_GetException (ctx);
        result.passed        = false;
        result.error_message = thrown_value_message (ctx, exc);
        JS_FreeValue (ctx, exc);
    } else if (arity > 0) {
        apply_done_verdict (ctx, state, result);
    } else {
        result.passed = true;
    }

    JS_FreeValue (ctx, done);
    JS_FreeValue (ctx, state);
    // An async callback's row is recorded passed without awaiting it, as
    // postman-sandbox does; what its promise later does is reported as a
    // script error after the job queue drains (#2531).
    if (JS_PromiseState (ctx, ret) != JS_PROMISE_NOT_A_PROMISE) {
        data->async_tests.emplace_back (ret, test_name);
    } else {
        JS_FreeValue (ctx, ret);
    }
    data->tests.push_back (std::move (result));

    // Postman returns `pm` so `pm.test(...).test(...)` runs both ("make it
    // chainable", verbatim in pmapi-setup-runner); the chain continues on the
    // `pm` the call was made on, `this` for every documented spelling.
    return JS_DupValue (ctx, this_val);
}

JSValue js_pm_expect (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "pm.expect requires a value");
    }

    // chai coerces the message rather than demanding a string, and reads
    // absent, `undefined` and `null` alike, how a conditional caller spells "no
    // message". A throwing conversion (a Symbol, a throwing `toString`) is a
    // real error and propagates, not swallowed into an empty prefix.
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
 * chai's `expect.fail([message])`: fail here, with this message, the one way a
 * script states a failure as an assertion rather than an error. Inside
 * `pm.test` both fail the test and at script level both abort; only the
 * verdict's shape differs, an `AssertionError` with this message, not a
 * misuse's `TypeError`. Reached as a property of `pm.expect`, chai's spelling.
 *
 * chai's four-argument form (`actual, expected, message, operator`) builds an
 * AssertionError carrying the two compared values, which this one has nowhere
 * to put, so it is refused by name: reading `actual` as the message (what a
 * single-argument implementation does with `fail(a, b)`) would report the value
 * as the failure text, the silent-wrong shape this program closes.
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

// ============================================================================
// jsonSchema and the response measures, which pm.response.to shares (#2528)
// ============================================================================

namespace {

/**
 * A script value as the JSON the validator reads: what `JSON.stringify` makes
 * of it, the value ajv sees in Postman. So a response body comes through here,
 * not as its text: JSON.parse reads `1.0` as the integer 1, and nlohmann on the
 * text would keep a float that `type: "integer"` refuses. nullopt with an
 * exception pending when the value has no JSON form; @p what names the argument
 * in the refusal.
 */
std::optional<nlohmann::json>
script_value_as_json (JSContext* ctx, JSValueConst value, const char* what) {
    ScopedValue text (ctx, JS_JSONStringify (ctx, value, JS_UNDEFINED, JS_UNDEFINED));
    if (JS_IsException (text.get ())) {
        // A cycle, a throwing toJSON, a BigInt: the script's own error, which
        // QuickJS has already named.
        return std::nullopt;
    }
    if (JS_IsString (text.get ())) {
        try {
            return std::optional<nlohmann::json> (std::in_place,
            nlohmann::json::parse (js_to_string (ctx, text.get ())));
        } catch (const nlohmann::json::exception&) {
            // @deliberate - a lone surrogate survives JSON.stringify as an
            // escape nlohmann refuses; it is refused below as no JSON form.
        }
    }
    JS_ThrowTypeError (ctx, "jsonSchema() needs %s JSON can represent, got %s",
    what, js_type_name (ctx, value));
    return std::nullopt;
}

// The first failure, by the path the validator names, and how many follow it.
std::string first_schema_failure (const vayu::core::ValidationVerdict& verdict) {
    if (verdict.failures.empty ()) {
        return "the schema";
    }
    const auto& first = verdict.failures.front ();
    std::string out   = std::format (
    "at {}: {}", first.path.empty () ? "the root" : first.path, first.message);
    if (verdict.failures_total > 1) {
        out += std::format (" (and {} more)", verdict.failures_total - 1);
    }
    return out;
}

} // namespace

std::optional<std::string>
json_schema_failure (JSContext* ctx, JSValueConst document, JSValueConst schema, bool negated) {
    // chai-postman's own first check, `expect(schema).to.be.an('object')`: an
    // array, a function or a boolean schema is refused there too.
    if (!JS_IsObject (schema) || JS_IsArray (schema) || JS_IsFunction (ctx, schema)) {
        JS_ThrowTypeError (ctx, "jsonSchema() expects a schema object, got %s",
        js_type_name (ctx, schema));
        return std::nullopt;
    }
    const auto schema_json = script_value_as_json (ctx, schema, "a schema");
    if (!schema_json) {
        return std::nullopt;
    }
    const auto document_json = script_value_as_json (ctx, document, "a target");
    if (!document_json) {
        return std::nullopt;
    }
    const auto verdict =
    vayu::core::validate_document_against_schema (*schema_json, *document_json);
    if (!verdict) {
        JS_ThrowTypeError (ctx, "jsonSchema() could not read the schema: %s",
        verdict.error ().c_str ());
        return std::nullopt;
    }

    const std::string expected = negated ?
    "Expected data to not satisfy the schema" :
    "Expected data to satisfy the schema";
    // A keyword the validator cannot evaluate leaves the verdict unknown both
    // ways (ignored inside `not` it makes the schema stricter, elsewhere
    // looser), so neither polarity may pass on it.
    if (!verdict->unevaluated_keywords.empty ()) {
        std::string msg = expected + ", but it " +
        vayu::core::unevaluated_keywords_disclosure (*verdict);
        if (!verdict->valid) {
            msg += "; of what was checked, the data fails " +
            first_schema_failure (*verdict);
        }
        return msg;
    }
    if (verdict->valid != negated) {
        return std::string{};
    }
    return negated ? expected :
                     expected + ", but it fails " + first_schema_failure (*verdict);
}

JSValue response_measure_chain (JSContext* ctx, double measured, bool negated, ResponseMeasure which) {
    ScopedValue number (ctx, JS_NewFloat64 (ctx, measured));
    ScopedValue expectation (ctx, create_expectation (ctx, number.get (), std::string{}));
    if (JS_IsException (expectation.get ())) {
        return JS_EXCEPTION;
    }
    const auto row = static_cast<size_t> (which);
    if (auto* state = expectation_state (ctx, expectation.get ())) {
        state->negated = negated;
        state->path    = response_measure_paths.at (row).at (negated ? 1 : 0);
    }
    return chainable_method (ctx, expectation.get (), response_measure_members.at (row));
}

} // namespace vayu::runtime::pm_detail
