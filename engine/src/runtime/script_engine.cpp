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
 * The `pm` object's surfaces live in `pm/`, one file per family, sharing
 * `pm/pm_internal.hpp`; what stays here is the console, base64 and
 * `pm.crypto`, the `pm` composer and the engine itself (issue #2092).
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
#include <chrono>
#include <cmath>
#include <iterator>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "vayu/core/query_encoding.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/graphql_body.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/sha256.hpp"

#include "pm/pm_internal.hpp"

namespace vayu::runtime {

#ifdef VAYU_HAS_QUICKJS

namespace pm_detail {
namespace {

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

} // namespace

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

namespace {

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

} // namespace

JSClassID request_url_class_id = 0;

namespace {

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

} // namespace

/// The state behind a Url object, or nullptr for anything else. A real class
/// test rather than a marker property, so a script cannot forge one by naming
/// a field the same thing.
RequestUrlState* request_url_state (JSValueConst value) {
    return static_cast<RequestUrlState*> (JS_GetOpaque (value, request_url_class_id));
}

namespace {

/**
 * @brief What `pm.request.body` carries (issue #1003).
 *
 * `body` is the composed body, which is where the mode and the field lists are
 * read from; `text` is the string view (`script_body_view`) the object answers
 * every string context with, and the one thing the write-back reads back. A
 * `.raw` assignment moves `text` and nothing else - the write-back applies it
 * through the same rules a whole-string assignment goes through, so there is one
 * definition of what assigning a body means rather than two.
 */
struct RequestBodyState {
    Body body;
    std::string text;
};

} // namespace

JSClassID request_body_class_id = 0;

namespace {

void request_body_finalizer (JSRuntime* rt, JSValue val) {
    (void)rt;
    delete static_cast<RequestBodyState*> (JS_GetOpaque (val, request_body_class_id));
}

// No gc_mark, for the reason the Url class gives: the state holds C++ values,
// never a JSValue.
JSClassDef request_body_class = { .class_name = "RequestBody",
    .finalizer                                = request_body_finalizer,
    .gc_mark                                  = nullptr,
    .call                                     = nullptr,
    .exotic                                   = nullptr };

/// The state behind a RequestBody object, or nullptr for anything else - a real
/// class test, for the reason `request_url_state` gives.
RequestBodyState* request_body_state (JSValueConst value) {
    return static_cast<RequestBodyState*> (JS_GetOpaque (value, request_body_class_id));
}

/**
 * @brief The text an assertion should read a string-like target as.
 *
 * A JS string, and the two objects that replaced one on `pm.request`: the Url
 * (#991) and the RequestBody (#1003). Both are documented as still behaving as
 * the string they replaced, and `pm.expect(pm.request.url).to.include(...)` is
 * the idiom in this repo's own docs and tests - a verdict that silently flipped
 * to failing is the worst thing an assertion can do, so the two are named here
 * rather than left to whichever branch an object falls into.
 *
 * Only these three. Coercing *any* object would make
 * `pm.expect({}).to.include('object')` pass.
 */
std::optional<std::string> expect_string_like (JSContext* ctx, JSValueConst value) {
    if (auto* url = request_url_state (value)) {
        return request_url_current_text (ctx, value, *url);
    }
    if (auto* body = request_body_state (value)) {
        return body->text;
    }
    if (JS_IsString (value)) {
        return js_to_string (ctx, value);
    }
    return std::nullopt;
}

} // namespace

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
script_url_text (JSContext* ctx, JSValueConst value, std::string* out_error) {
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

JSClassDef expect_class = { .class_name = "Expectation",
    .finalizer                          = expect_finalizer,
    .gc_mark                            = expect_gc_mark,
    .call                               = nullptr,
    .exotic                             = &expect_exotic };

} // namespace

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

/**
 * The name a binary body's file goes by in a script: its declared `fileName`,
 * else the last segment of its path - the rule `declared_file_name` applies to
 * a form-data file part. Never the path itself, which is one machine's
 * filesystem and can carry a user name (issue #411).
 */
std::string body_file_name (const FileRef& file) {
    FormField part;
    part.src       = file.src;
    part.file_name = file.file_name;
    return vayu::http::declared_file_name (part);
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
 *
 * A `binary` body reads as `@<fileName>`, the spelling a form-data file part
 * already uses: its bytes are a file the script never sees, and its path is
 * never disclosed (see `body_file_name`).
 */
std::string script_body_view (const Body& body) {
    if (body.mode == BodyMode::FormData) {
        return vayu::http::render_form_data_parts (body.fields);
    }
    if (body.mode == BodyMode::Binary) {
        return "@" + body_file_name (body.file);
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

/// Whether the request a script runs against sends its query encoded, which
/// is when `add` and `upsert` store a row's key and value as the wire has them.
bool script_query_is_encoded (JSContext* ctx) {
    const auto* data = get_context_data (ctx);
    return data == nullptr || data->request == nullptr || !data->request->disable_url_encoding;
}

/// A name a script looks a param up by. A row `add` wrote holds its key as
/// sent (`a%20b`), and Postman's row holds it as typed, so a name matches a
/// key written either way: `get('a b')` after `add({key: 'a b'})` finds it.
class QueryParamName {
    public:
    QueryParamName (JSContext* ctx, std::string typed)
    : typed_ (std::move (typed)),
      encoded_ (script_query_is_encoded (ctx) ?
      vayu::core::encode_query_component (typed_, vayu::core::QueryPart::Key) :
      typed_) {
    }

    [[nodiscard]] bool matches (const std::string& key) const {
        return key == typed_ || key == encoded_;
    }

    private:
    std::string typed_;
    std::string encoded_;
};

/// The value of the first param named @p name, or nullptr when there is none.
const std::optional<std::string>*
find_query_param (const RequestUrlState& state, const QueryParamName& name) {
    for (const auto& param : state.parts.query_params) {
        if (name.matches (param.key)) {
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
    const QueryParamName name (ctx, js_to_string (ctx, argv[0]));
    const auto* found = find_query_param (*state, name);
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
    // Encoded here, as the send would write it (issue #1773): the rows hold
    // wire bytes, so `all` and `getQueryString()` read what goes out. Postman
    // adds a row and `normalizeParam` writes it, so the per-row rule applies.
    const QueryParamName name (ctx, param.key);
    if (script_query_is_encoded (ctx)) {
        param.key =
        vayu::core::encode_query_component (param.key, vayu::core::QueryPart::Key);
        if (param.value) {
            param.value = vayu::core::encode_query_component (
            *param.value, vayu::core::QueryPart::Value);
        }
    }
    auto& params = state->parts.query_params;
    if (magic == QUERY_UPSERT) {
        for (auto& existing : params) {
            if (name.matches (existing.key)) {
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
    const QueryParamName name (ctx, js_to_string (ctx, argv[0]));
    auto& params        = state->parts.query_params;
    const size_t before = params.size ();
    std::erase_if (params,
    [&name] (const vayu::http::UrlQueryParam& p) { return name.matches (p.key); });
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

// ---------------------------------------------------------------------------
// pm.request.body - Postman's RequestBody object (issue #1003)
// ---------------------------------------------------------------------------

/// Which member a bound accessor answers for.
enum BodyMember : std::uint8_t {
    BODY_MODE,
    BODY_RAW,
    BODY_URLENCODED,
    BODY_FORMDATA,
    BODY_GRAPHQL,
    BODY_FILE,
    BODY_LENGTH
};

/**
 * @brief The Postman mode name this body reads as.
 *
 * Five names, because those are the five shapes a script can *act* on: a string
 * it can parse, a pair list, a multipart part list, a GraphQL operation and a
 * file. Vayu's other content modes - `json`, `text`, `xml`, `jsonrpc` - each
 * carry their body as one string, which is what `raw` means, so a lifted
 * `body.mode === 'raw'` guard answers true for every one of them.
 *
 * `graphql` was the third name for the whole of #1003, because Postman's mode
 * promises a `{query, variables}` member and this engine stores a GraphQL body
 * as one string that may be an envelope or a bare document. What #1111 found is
 * that the pair is *derivable* from that string by a rule the engine already
 * owns - `graphql_body.hpp`'s classifier, the one the send itself goes through
 * - so the member has something to fill it from after all. See
 * `body_graphql_view`.
 *
 * A `binary` body is Postman's fifth mode, `file`: one file sent as the whole
 * body. Postman's `file` member promises `src`, the path, which this one never
 * answers - a path is one machine's filesystem, and a form-data file part is
 * held to the same rule (issue #411, `declared_file_name`). It answers
 * `{name, size?}` instead (`body_file_view`).
 */
const char* postman_body_mode (BodyMode mode) {
    switch (mode) {
    case BodyMode::Form: return "urlencoded";
    case BodyMode::FormData: return "formdata";
    case BodyMode::GraphQL: return "graphql";
    case BodyMode::Binary: return "file";
    // `None` never reaches here: a bodyless request defines no `body` property
    // at all, so no object is built for it. See setup_pm_request.
    default: return "raw";
    }
}

/// The member a magic stands for, for the refusal that has to name it.
const char* body_member_name (int magic) {
    switch (magic) {
    case BODY_MODE: return "mode";
    case BODY_RAW: return "raw";
    case BODY_URLENCODED: return "urlencoded";
    case BODY_FORMDATA: return "formdata";
    case BODY_GRAPHQL: return "graphql";
    case BODY_FILE: return "file";
    default: return "length";
    }
}

/// One form field as Postman presents it - a read-only view of a composed part.
JSValue body_field_entry (JSContext* ctx, const FormField& field, bool multipart) {
    JSValue entry     = JS_NewObject (ctx);
    const auto define = [&] (const char* name, JSValue value) {
        JS_DefinePropertyValueStr (ctx, entry, name, value, JS_PROP_ENUMERABLE);
    };
    const auto define_text = [&] (const char* name, const std::string& text) {
        define (name, JS_NewStringLen (ctx, text.data (), text.size ()));
    };
    define_text ("key", field.key);
    if (multipart && field.type == FormFieldType::File) {
        // No `value` at all, rather than the `""` a file part's `value` holds:
        // an empty string here reads as a text field that happens to be empty,
        // which is the one distinction `render_form_data_parts` exists to keep
        // (issue #411). What a script may see is the name the *server* is told,
        // never the path - see `declared_file_name`.
        define ("type", JS_NewString (ctx, "file"));
        define_text ("fileName", vayu::http::declared_file_name (field));
    } else {
        define_text ("value", field.value);
        if (multipart) {
            define ("type", JS_NewString (ctx, "text"));
        }
    }
    // Disabled rows are listed rather than dropped, unlike the string view: the
    // list is what a script inspects the *request* with, and a row it cannot see
    // is one it would re-add. The flag is what says the row is not sent.
    define ("disabled", JS_NewBool (ctx, !field.enabled));
    (void)JS_PreventExtensions (ctx, entry);
    return entry;
}

/**
 * @brief The read-only list `.urlencoded` / `.formdata` answer with.
 *
 * Not extensible, and its entries not writable, so `push`, `splice` and a field
 * assignment throw instead of editing a list nothing reads back. #1003 keeps the
 * write surface exactly as it shipped - a whole-body string, or `.raw` - and a
 * list that quietly accepted edits would be the silent-wrong shape again.
 */
JSValue body_field_list (JSContext* ctx, const std::vector<FormField>& fields, bool multipart) {
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& field : fields) {
        JS_SetPropertyUint32 (ctx, list, next++, body_field_entry (ctx, field, multipart));
    }
    (void)JS_PreventExtensions (ctx, list);
    return list;
}

/**
 * @brief `.graphql` - Postman's `{query, variables}`, read off the one string.
 *
 * A GraphQL body is stored as one string that is allowed to be either the
 * `{"query": ...}` envelope the request builder writes or the bare document an
 * agent or a `curl` caller hands over, and `graphql_body.hpp` is what decides
 * which. This asks *that* classifier rather than a second copy of the rule, so
 * `.graphql.query` is the query the send would carry - a copy could call the
 * same body an envelope here and a document at the wire, which is the one
 * failure adding this member could introduce.
 *
 * Three answers, one per case the classifier separates:
 *
 * - A readable envelope: its own `query`, and `variables` when it carries them.
 * - A bare document: `{query: <the document>}` - what wrapping it would send.
 * - Object-shaped text that does not parse (an envelope whose `{{token}}` went
 *   unresolved, or a mistyped one): **undefined**. `graphql_wire_body` passes
 *   that through untouched rather than guessing at it, and any pair invented
 *   here would be the guess it refuses. `.raw` still carries the string, so the
 *   body is described as unreadable rather than hidden.
 *
 * An empty body answers `undefined` for the reason the header gives: empty in,
 * empty out, and `{query: ""}` would give a bodiless request a query.
 *
 * `variables` is the JSON value the envelope carries, where Postman's is the
 * *text* of its variables editor - a divergence rather than an oversight: Vayu
 * never stored that text, and serializing one here would invent whitespace and
 * key order the user never wrote, which is the thing `graphql_wire_body`
 * refuses to do at the wire. `docs/app/pm-api-compatibility.md` states it.
 */
JSValue body_graphql_view (JSContext* ctx, const std::string& text) {
    if (text.empty ()) {
        return JS_UNDEFINED;
    }
    const auto define = [&] (JSValue object, const char* name, JSValue value) {
        JS_DefinePropertyValueStr (ctx, object, name, value, JS_PROP_ENUMERABLE);
    };
    const auto frozen = [&] (JSValue object) {
        (void)JS_PreventExtensions (ctx, object);
        return object;
    };
    if (!vayu::http::graphql_body_is_enveloped (text)) {
        JSValue document = JS_NewObject (ctx);
        define (document, "query", JS_NewStringLen (ctx, text.data (), text.size ()));
        return frozen (document);
    }
    const auto document =
    nlohmann::json::parse (text, nullptr, /*allow_exceptions=*/false);
    if (document.is_discarded ()) {
        // The classifier's object-shaped-but-unreadable case: it said envelope
        // on the shape alone, and there is nothing under the shape to read.
        return JS_UNDEFINED;
    }
    // QuickJS is handed what nlohmann *read*, never the bytes it read them from.
    // The two are not the same grammar - a leading byte-order mark is nlohmann's
    // to skip and `JSON.parse`'s to reject - so parsing the body twice lets the
    // send carry a query this member answers `undefined` about. Only one reader
    // of a body may have an opinion, and it is the one the send asks; the dump
    // is a transport between them, not a second reading.
    const std::string canonical =
    document.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    JSValue envelope = JS_ParseJSON (
    ctx, canonical.c_str (), canonical.size (), "<pm.request.body.graphql>");
    if (JS_IsException (envelope)) {
        // Not reachable through any body: `canonical` is what nlohmann just
        // serialized, and `replace` leaves it valid JSON even for a lone UTF-8
        // continuation byte. Handled rather than assumed, because the
        // alternative is a parse error escaping a getter.
        JS_FreeValue (ctx, envelope);
        JSValue pending = JS_GetException (ctx);
        JS_FreeValue (ctx, pending);
        return JS_UNDEFINED;
    }
    JSValue query = JS_GetPropertyStr (ctx, envelope, "query");
    if (!JS_IsString (query)) {
        // Also not reachable: the classifier returned true on a parse that was
        // not discarded, which is exactly its "object with a string `query`"
        // case, and the round trip above preserves the type. Restated as a
        // guard rather than assumed, so the function stays total.
        JS_FreeValue (ctx, query);
        JS_FreeValue (ctx, envelope);
        return JS_UNDEFINED;
    }
    JSValue variables = JS_GetPropertyStr (ctx, envelope, "variables");
    JSValue view      = JS_NewObject (ctx);
    define (view, "query", query);
    // Absent rather than `undefined`-valued, so `'variables' in body.graphql`
    // answers what the envelope actually carries.
    if (JS_IsUndefined (variables)) {
        JS_FreeValue (ctx, variables);
    } else {
        define (view, "variables", variables);
    }
    JS_FreeValue (ctx, envelope);
    return frozen (view);
}

/**
 * @brief `.file` - a binary body's file as a script may see it: `{name}`, plus
 * `size` once the send has measured the file (`FileRef::sha256` is set by the
 * same step). Never `src`: see `postman_body_mode`. Frozen, like every other
 * descriptive member.
 */
JSValue body_file_view (JSContext* ctx, const FileRef& file) {
    JSValue view           = JS_NewObject (ctx);
    const std::string name = body_file_name (file);
    JS_DefinePropertyValueStr (ctx, view, "name",
    JS_NewStringLen (ctx, name.data (), name.size ()), JS_PROP_ENUMERABLE);
    if (!file.sha256.empty ()) {
        JS_DefinePropertyValueStr (ctx, view, "size",
        JS_NewInt64 (ctx, static_cast<int64_t> (file.size)), JS_PROP_ENUMERABLE);
    }
    (void)JS_PreventExtensions (ctx, view);
    return view;
}

/**
 * The body as a string, and the single answer behind every string context.
 *
 * `toString`, `valueOf`, `toJSON` and `@@toPrimitive` all land here, for the
 * reason `js_url_to_string` gives: concatenation, a template literal, `==`
 * against a string, `JSON.stringify` and `String.prototype`'s generic methods
 * keep behaving the way they did when this was a string.
 */
JSValue js_body_to_string (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* state = request_body_state (this_val);
    if (!state) {
        return JS_ThrowTypeError (ctx, "not a pm.request.body object");
    }
    return JS_NewStringLen (ctx, state->text.data (), state->text.size ());
}

JSValue js_body_member_get (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)argc;
    (void)argv;
    (void)func_data;
    auto* state = request_body_state (this_val);
    if (!state) {
        return JS_ThrowTypeError (ctx, "not a pm.request.body object");
    }
    switch (magic) {
    case BODY_MODE:
        return JS_NewString (ctx, postman_body_mode (state->body.mode));
    // `.raw` is the string view for **every** mode, where Postman leaves it
    // undefined for the two form ones. That is the divergence #411 already
    // decided: a form body reading as nothing is indistinguishable from a
    // request with no body, and this object exists to add answers rather than
    // take one back.
    case BODY_RAW:
        return JS_NewStringLen (ctx, state->text.data (), state->text.size ());
    case BODY_URLENCODED:
        return state->body.mode == BodyMode::Form ?
        body_field_list (ctx, state->body.fields, /*multipart=*/false) :
        JS_UNDEFINED;
    case BODY_FORMDATA:
        return state->body.mode == BodyMode::FormData ?
        body_field_list (ctx, state->body.fields, /*multipart=*/true) :
        JS_UNDEFINED;
    // Read off `text` rather than `body.content`, so a script that assigned
    // `.raw` reads the pair its *new* string carries. One string, one answer -
    // the two disagreeing would be `.graphql` describing a body no longer sent.
    case BODY_GRAPHQL:
        return state->body.mode == BodyMode::GraphQL ?
        body_graphql_view (ctx, state->text) :
        JS_UNDEFINED;
    case BODY_FILE:
        return state->body.mode == BodyMode::Binary ?
        body_file_view (ctx, state->body.file) :
        JS_UNDEFINED;
    // Defined rather than left to the prototype, for the reason #991 gives
    // about the URL's: `String.prototype` is a String object holding `""`, so
    // an inherited `length` answers 0 - a plausible number for a body that is
    // not empty, and `docs/engine/scripting.md` sets Content-Length from it.
    case BODY_LENGTH:
        return JS_NewInt64 (ctx, static_cast<int64_t> (state->text.size ()));
    default: return JS_UNDEFINED;
    }
}

JSValue js_body_member_set (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)func_data;
    auto* state = request_body_state (this_val);
    if (!state) {
        return JS_ThrowTypeError (ctx, "not a pm.request.body object");
    }
    if (magic != BODY_RAW) {
        // The members that *describe* the body rather than carry it. Refused at
        // the assignment rather than ignored: a script that set `.mode` or
        // rebuilt `.urlencoded` would otherwise send the body it started with
        // and be told nothing, which is the exact silent-wrong shape this
        // program exists to close.
        return JS_ThrowTypeError (ctx,
        "pm.request.body.%s is read-only - assign pm.request.body or "
        "pm.request.body.raw to change what is sent, or edit the request's "
        "form "
        "fields",
        body_member_name (magic));
    }
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "pm.request.body.raw must be assigned a string, got %s",
        argc > 0 ? js_type_name (ctx, argv[0]) : "no value");
    }
    // Only the view moves. What assigning a body *means* - the untouched rule,
    // the urlencoded parse-back, the form-data refusal - is the write-back's,
    // and is reached identically whether the script assigned `.raw` or the whole
    // body. One definition, not two.
    state->text = js_to_string (ctx, argv[0]);
    return JS_UNDEFINED;
}

/**
 * @brief A RequestBody object over @p body, with the Postman members on it.
 *
 * A plain property on `pm.request` rather than #991's accessor pair, and the one
 * place this shape departs from that precedent. The URL needed an accessor so
 * that `pm.request.url = x` left a Url object behind; for the body, a string
 * assignment leaving a plain string *is* the shipped contract, and `null` and
 * `delete` both mean "send no body" - an accessor would have to carry an
 * emptied-state flag to keep saying so, machinery bought for a chained access
 * nothing asks for.
 */
JSValue new_request_body (JSContext* ctx, const Body& body) {
    JSValue object = JS_NewObjectClass (ctx, request_body_class_id);
    if (JS_IsException (object)) {
        return object;
    }
    auto* state = new RequestBodyState{ body, script_body_view (body) };
    if (JS_SetOpaque (object, state) < 0) {
        // The object is not of this class, so the finalizer will never run and
        // nothing else would free the state.
        delete state;
        JS_FreeValue (ctx, object);
        return JS_EXCEPTION;
    }

    // Defined rather than set, for the reason build_request_url_members gives:
    // `String.prototype` is the prototype here, and `[[Set]]` consults it.
    const auto define = [&] (const char* name, JSValue value) {
        JS_DefinePropertyValueStr (ctx, object, name, value, JS_PROP_C_W_E);
    };
    define ("toString", JS_NewCFunction (ctx, js_body_to_string, "toString", 0));
    define ("valueOf", JS_NewCFunction (ctx, js_body_to_string, "valueOf", 0));
    define ("toJSON", JS_NewCFunction (ctx, js_body_to_string, "toJSON", 0));
    JSAtom to_primitive = well_known_symbol_atom (ctx, "toPrimitive");
    JS_DefinePropertyValue (ctx, object, to_primitive,
    JS_NewCFunction (ctx, js_body_to_string, "[Symbol.toPrimitive]", 1),
    JS_PROP_CONFIGURABLE);
    JS_FreeAtom (ctx, to_primitive);

    // Accessors, not values: a read is answered from the state, and a write
    // reaches it or is refused by name. `this` carries the state, so the pair
    // needs no bound data - and a getter pulled off the object and called on
    // something else finds no state and throws rather than reading one.
    const auto define_accessor = [&] (const char* name, int magic) {
        JSAtom atom = JS_NewAtom (ctx, name);
        JS_DefinePropertyGetSet (ctx, object, atom,
        JS_NewCFunctionData (ctx, js_body_member_get, 0, magic, 0, nullptr),
        JS_NewCFunctionData (ctx, js_body_member_set, 1, magic, 0, nullptr),
        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
        JS_FreeAtom (ctx, atom);
    };
    define_accessor ("mode", BODY_MODE);
    define_accessor ("raw", BODY_RAW);
    define_accessor ("urlencoded", BODY_URLENCODED);
    define_accessor ("formdata", BODY_FORMDATA);
    define_accessor ("graphql", BODY_GRAPHQL);
    define_accessor ("file", BODY_FILE);
    define_accessor ("length", BODY_LENGTH);
    return object;
}

/**
 * @brief The body text a value carries, the sibling of `script_url_text`.
 *
 * A JS string is itself; a RequestBody object is the string view it holds, which
 * a `.raw` assignment has already moved. Anything else is `nullopt`, and the
 * caller says so in its own words.
 *
 * Deliberately *not* "any object, via toString": `pm.request.body = {}` would
 * then become the string `[object Object]` and reach the wire, which is exactly
 * the silent-wrong-request class this program exists to close.
 */
std::optional<std::string> script_body_text (JSContext* ctx, JSValueConst value) {
    if (JS_IsString (value)) {
        return js_to_string (ctx, value);
    }
    if (auto* state = request_body_state (value)) {
        return state->text;
    }
    return std::nullopt;
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

        // pm.request.body - Postman's RequestBody object, not the string it used
        // to be (issue #1003). It still *reads* as that string in every context
        // JavaScript allows, and the string is still what an assignment means.
        // A bodyless request defines no property at all, so
        // `typeof pm.request.body` stays the way a script tells "no body" from
        // "a body that happens to be empty".
        if (data->request->body.mode != BodyMode::None) {
            JSValue body = new_request_body (ctx, data->request->body);
            if (JS_IsException (body)) {
                // Defining the exception sentinel as a property would make
                // `pm.request.body` an object no read can touch. A request with
                // no reachable body reads as one with no body, which is the
                // failure this can degrade to honestly. Same guard, same
                // reason, as install_request_url.
                JS_FreeValue (ctx, body);
            } else {
                JS_SetPropertyStr (ctx, request, "body", body);
            }
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
 * `iteration` and `vu` are present wherever a real one exists: a scenario run's
 * steps, a load run's sampled response (issue #994), and a send that bound a
 * data row, which is row 0 of 1. `iterationCount` is narrower - the scenario
 * runner's total, or that send's `1` - and no load run sets it: a
 * duration-bounded one has no total, and a field readable from one load shape
 * and not another is worse than one that is never readable there. An ordinary
 * Send sets none of the three, so the script reads `undefined` (see
 * ScriptContext).
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
            const char* event_name = "test";
            switch (*data->event) {
            case ScriptEvent::PreRequest: event_name = "prerequest"; break;
            case ScriptEvent::Test: event_name = "test"; break;
            case ScriptEvent::Setup: event_name = "setup"; break;
            case ScriptEvent::Teardown: event_name = "teardown"; break;
            }
            JS_SetPropertyStr (ctx, info, "eventName", JS_NewString (ctx, event_name));
        }
        if (data->vu) {
            JS_SetPropertyStr (ctx, info, "vu",
            JS_NewInt64 (ctx, static_cast<int64_t> (*data->vu)));
        }
        if (data->iteration) {
            JS_SetPropertyStr (ctx, info, "iteration",
            JS_NewInt64 (ctx, static_cast<int64_t> (*data->iteration)));
        }
        if (data->iteration_count) {
            JS_SetPropertyStr (ctx, info, "iterationCount",
            JS_NewInt64 (ctx, static_cast<int64_t> (*data->iteration_count)));
        }
        if (data->run_summary) {
            JSValue run = JS_NewObject (ctx);
            JS_SetPropertyStr (ctx, run, "requestsSent",
            JS_NewInt64 (ctx, static_cast<int64_t> (data->run_summary->requests_sent)));
            JS_SetPropertyStr (ctx, run, "errorRate",
            JS_NewFloat64 (ctx, data->run_summary->error_rate));
            JS_SetPropertyStr (ctx, run, "assertionsPassed",
            JS_NewInt64 (ctx, static_cast<int64_t> (data->run_summary->assertions_passed)));
            JS_SetPropertyStr (ctx, run, "assertionsFailed",
            JS_NewInt64 (ctx, static_cast<int64_t> (data->run_summary->assertions_failed)));
            JS_SetPropertyStr (ctx, info, "run", run);
        }
    }

    JS_SetPropertyStr (ctx, pm, "info", info);
}

} // namespace

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

namespace {

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
    method_text = vayu::utils::ascii_upper (method_text);
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
    } else if (auto staged_text = script_body_text (ctx, js_body.get ())) {
        // Either shape: the RequestBody object `pm.request.body` normally holds,
        // or a plain string, which is what an assignment leaves there. Both are
        // the body as a string, and both mean the same thing from here on.
        std::string body_text = std::move (*staged_text);
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
            // One of the two modes whose string view is not what goes on the
            // wire (binary is the other), so it cannot take a string back.
            // Parsing one into text parts would also be the wrong shape the
            // moment a part can be a file (issue #393): a script appending a
            // field would silently drop the upload. Refused rather than applied
            // to a body the transfer layer would then ignore.
            return std::string (
            "pm.request.body cannot be assigned on a form-data request: its "
            "parts are multipart, not a string - edit the request's form "
            "fields, or delete pm.request.body to send no body");
        } else if (staged.body.mode == BodyMode::Binary) {
            // The body is a file, and a script never chooses which: the string
            // view names it, and a string written back would be sent as
            // nothing at all, since this mode sends `file` and not `content`.
            return std::string (
            "pm.request.body cannot be assigned on a binary request: its body "
            "is a file, not a string - choose the file in the request, or "
            "delete pm.request.body to send no body");
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
        return "pm.request.body must be a string or a request body object, "
               "got " +
        std::string (js_type_name (ctx, js_body.get ()));
    }

    request = std::move (staged);
    return std::nullopt;
}

void setup_pm_object (JSContext* ctx) {
    JSValue global = JS_GetGlobalObject (ctx);
    JSValue pm     = JS_NewObject (ctx);

    // A class registered with JS_NewClass has no prototype until one is set, so
    // without this the pm.response.to.* and pm.expect(...) objects would answer
    // nothing but their own members - toString, hasOwnProperty and friends would
    // reach the unknown-member hook and throw. Both chains are armed, so both
    // need it; `JS_SetClassProto` takes ownership of the value it is given, so
    // the first call gets a reference of its own.
    JSValue plain        = JS_NewObject (ctx);
    JSValue object_proto = JS_GetPrototype (ctx, plain);
    JS_FreeValue (ctx, plain);
    JS_SetClassProto (ctx, expect_class_id, JS_DupValue (ctx, object_proto));
    JS_SetClassProto (ctx, response_chain_class_id, object_proto);

    // `pm.request.url` inherits from **String.prototype**, which is the whole
    // of how `url.startsWith(...)`, `.includes(...)`, `.slice(...)` and the
    // rest keep working on what used to be a string: every one of them coerces
    // through `ToString(this)`, which the object's own `@@toPrimitive` answers
    // with the URL. What it does not restore is `.length` - an own property of
    // a real string, and one of the three breaks #991 documents.
    // `pm.request.body` inherits from it for the same reason (issue #1003), so
    // the first call gets a reference of its own - `JS_SetClassProto` takes
    // ownership of the value it is given.
    JSValue string_ctor  = JS_GetPropertyStr (ctx, global, "String");
    JSValue string_proto = JS_GetPropertyStr (ctx, string_ctor, "prototype");
    JS_FreeValue (ctx, string_ctor);
    JS_SetClassProto (ctx, request_body_class_id, JS_DupValue (ctx, string_proto));
    JS_SetClassProto (ctx, request_url_class_id, string_proto);

    // pm.test()
    JS_SetPropertyStr (ctx, pm, "test", JS_NewCFunction (ctx, js_pm_test, "test", 2));

    // pm.expect(), with chai's `expect.fail` on the function object itself.
    // The first member on a callable here: a JS function *is* an object, so
    // the property write is ordinary - what is new is holding the function
    // value long enough to write to it instead of handing it straight to `pm`.
    JSValue expect_fn = JS_NewCFunction (ctx, js_pm_expect, "expect", 1);
    JS_SetPropertyStr (
    ctx, expect_fn, "fail", JS_NewCFunction (ctx, js_pm_expect_fail, "fail", 1));
    JS_SetPropertyStr (ctx, pm, "expect", expect_fn);

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
    setup_pm_variable_scopes (ctx, pm);

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

    // pm.metrics - custom trends, counters and rates (issue #1500), bound the
    // same way and for the same reason as pm.execution above.
    setup_pm_metrics (ctx, pm);

    // pm.sendRequest - always bound, even when the capability is off, so a
    // script that calls it gets a sentence explaining why rather than
    // "not a function".
    JS_SetPropertyStr (ctx, pm, "sendRequest",
    JS_NewCFunction (ctx, js_pm_send_request, "sendRequest", 2));

    JS_SetPropertyStr (ctx, global, "pm", pm);
    JS_FreeValue (ctx, global);
}

// expect_class_id / response_chain_class_id / request_url_class_id /
// request_body_class_id are process-wide: every native callback looks one up
// by name (JS_GetOpaque (ctx, ..., xxx_class_id)) rather than through the
// JSRuntime that happens to own its JSContext, since each OS thread owns a
// wholly separate JSRuntime (QuickJS's own is not thread-safe) but the four
// ids must still agree across all of them. The zero-check-then-JS_NewClassID
// sequence that assigns each one is neither atomic nor idempotent under a
// race - two threads creating their first JSRuntime concurrently can
// interleave the read and the write, corrupting the id one native callback
// later dereferences (root cause of #1589's intermittent segfault). This
// mutex makes that one-time assignment, plus the JS_NewClass registration
// that depends on the id being final, happen under one lock; it is not on
// any per-request hot path, only on first JSRuntime creation per thread.
std::mutex& class_id_registration_mutex () {
    static std::mutex mutex;
    return mutex;
}

} // anonymous namespace
} // namespace pm_detail

// `ScriptEngine::Impl` below reads the shared state and every installer.
using namespace pm_detail;

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
    if (std::chrono::steady_clock::now () <= state->deadline)
        return 0;
    state->interrupted = true;
    return 1;
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
        // (freed with it) and refreshed before each execute().
        auto* rt_state = new RuntimeState ();
        JS_SetRuntimeOpaque (rt, rt_state);
        JS_SetInterruptHandler (rt, &script_interrupt_handler, rt_state);

        // The four ids below are process-wide (see class_id_registration_mutex's
        // comment); this lock is what makes their first assignment, and the
        // JS_NewClass calls that depend on the final value, safe across the
        // per-thread JSRuntimes that race to create their first context.
        {
            std::lock_guard<std::mutex> id_lock (class_id_registration_mutex ());

            // Register Expectation class
            if (expect_class_id == 0) {
                JS_NewClassID (rt, &expect_class_id);
            }
            JS_NewClass (rt, expect_class_id, &expect_class);

            // Register the pm.response.to.* chain class, whose exotic hook makes
            // an unknown assertion throw instead of silently evaluating to
            // undefined.
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

            // Register the pm.request.body class - same story, same prototype.
            if (request_body_class_id == 0) {
                JS_NewClassID (rt, &request_body_class_id);
            }
            JS_NewClass (rt, request_body_class_id, &request_body_class);
        }

        JSContext* ctx = build_context (rt);
        if (!ctx) {
            delete rt_state;
            JS_FreeRuntime (rt);
            return { nullptr, nullptr };
        }

        return { rt, ctx };
    }

    /// A context with the standard intrinsics and the sandbox globals
    /// (`console`, `btoa`/`atob`, `pm`) and nothing else.
    JSContext* build_context (JSRuntime* rt) {
        JSContext* ctx = JS_NewContext (rt);
        if (!ctx) {
            return nullptr;
        }
        if (config.enable_console) {
            setup_console (ctx);
        }
        setup_base64_globals (ctx);
        setup_pm_object (ctx);
        return ctx;
    }

    /// The pool holds runtimes, not contexts: a script can reassign `pm` or
    /// `console`, patch `String.prototype` or `Array.prototype`, or leave a
    /// global behind, and a context that survived it would hand all of that to
    /// the next script on the thread - possibly another collection's (#1782).
    /// Freezing and diffing cannot cover every intrinsic a script can reach, so
    /// the context is rebuilt instead; the runtime (limits, interrupt handler,
    /// class registrations) is what is worth keeping.
    ///
    /// Unless a promise job is still queued (#1823): each job holds functions
    /// that pin their context, so `JS_FreeContext` would free nothing and the
    /// runtime would fill with dead contexts until its memory limit failed a
    /// later script. Draining the queue is not the answer, because it would
    /// run user code after the script ended, unbounded when `timeout_ms` is 0.
    /// `JS_FreeRuntime` drops the queued jobs unrun, which releases the context.
    void release_context (ContextPair pair) {
        if (!pair.first || !pair.second)
            return;

        const bool jobs_pending = JS_IsJobPending (pair.first);
        JS_FreeContext (pair.second);
        if (jobs_pending) {
            free_runtime (pair.first);
            return;
        }
        // Collect what the script left so the runtime goes back to the pool at
        // its baseline footprint.
        JS_RunGC (pair.first);

        JSContext* fresh = build_context (pair.first);
        if (!fresh) {
            free_runtime (pair.first);
            return;
        }

        std::lock_guard<std::mutex> lock (pool_mutex);
        context_pool.push_back ({ pair.first, fresh });
    }

    /// For a runtime whose contexts are all freed. The `RuntimeState` goes
    /// last: the runtime's interrupt handler holds it until the runtime is gone.
    static void free_runtime (JSRuntime* rt) {
        auto* rt_state = static_cast<RuntimeState*> (JS_GetRuntimeOpaque (rt));
        JS_FreeRuntime (rt);
        delete rt_state;
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
            rt_state->enabled     = config.timeout_ms != 0;
            rt_state->interrupted = false;
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
        ctx_data.vu                  = ctx.vu;
        ctx_data.iteration_count     = ctx.iteration_count;
        ctx_data.run_summary         = ctx.run_summary;
        ctx_data.iteration_data      = ctx.iteration_data;
        ctx_data.response_events     = ctx.response_events;
        // Both per-execution: the capability is this caller's, and the request
        // budget starts full for every script rather than carrying over
        // through a pooled context.
        ctx_data.allow_send_request  = config.allow_send_request;
        ctx_data.send_request_count  = 0;
        ctx_data.cookie_jar          = ctx.cookie_jar;
        ctx_data.cookie_scope        = ctx.cookie_scope;
        ctx_data.cookie_writes       = ctx.cookie_writes;
        ctx_data.cookie_read_lines   = ctx.cookie_read_lines;
        ctx_data.cookie_read_refusal = ctx.cookie_read_refusal;
        ctx_data.transport           = ctx.transport;
        ctx_data.default_headers     = ctx.default_headers;
        ctx_data.max_response_bytes  = ctx.max_response_bytes;
        ctx_data.in_scenario         = ctx.in_scenario;
        ctx_data.record_metric       = ctx.record_metric;
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
            // Whether the deadline stopped this script is the interrupt
            // handler's to answer, not the clock's - the same question #1056
            // settled one layer down. An error that merely *lands* past the
            // deadline is still that error: a script's own throw at the buzzer,
            // and `pm.sendRequest` refusing a spent budget from a blocking C
            // function the handler never gets to interrupt. Comparing the clock
            // here replaced the sentence naming the fault with a timeout line
            // the user could not act on.
            if (script_deadline_expired (js_ctx)) {
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
