/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_legacy.cpp
 * @brief Postman's pre-`pm.*` globals (#2577): the `postman` object and the
 *        values Postman binds beside it.
 *
 * The shape follows postman-sandbox's `lib/sandbox/postman-legacy-interface.js`.
 *
 * Each `postman` method is an alias of the `pm` member Postman itself names as
 * its replacement (`LEGACY_GLOBS_ALTERNATIVES`), so a legacy call and its
 * `pm.*` spelling cannot answer differently: every method passes on exactly the
 * arguments Postman's does, the two setters stringify their value first, and
 * the two response readers exist only where there is a response.
 *
 * The values are read once, when the script starts, as Postman reads them, and
 * from the `pm` member that replaces each wherever there is one. `environment`
 * and `globals` are snapshots: writing to one changes no variable, and only the
 * legacy `postman` setters write through to them. `tests` is read back once the
 * script has finished (`record_legacy_tests`). The `response*` values exist
 * only where there is a response.
 */

#include "pm_internal.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/http/status.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

/// Whether an alias passes its value argument on as given, or first turns it
/// into the string Postman's legacy setters store.
enum class LegacyValue : std::uint8_t { AsGiven, Stringified };

/// Where a method exists: in every script, or only where there is a response.
enum class LegacyPhase : std::uint8_t { Any, Response };

/// What a method also does to its scope's snapshot (the `environment` or
/// `globals` global), as Postman's legacy methods write through to theirs.
enum class LegacyMirror : std::uint8_t { None, Set, Unset, Clear };

struct LegacyAlias {
    const char* name;  ///< the member of `postman`
    const char* owner; ///< the `pm` member, dotted, the target is a method of
    const char* method;
    int arity; ///< how many arguments Postman's method passes on
    LegacyValue value   = LegacyValue::AsGiven;
    LegacyPhase phase   = LegacyPhase::Any;
    LegacyMirror mirror = LegacyMirror::None;
};

constexpr int MAX_LEGACY_ARITY = 2;

constexpr auto LEGACY_ALIASES = std::to_array<LegacyAlias> ({
{ "setEnvironmentVariable", "environment", "set", 2, LegacyValue::Stringified,
LegacyPhase::Any, LegacyMirror::Set },
{ "getEnvironmentVariable", "environment", "get", 1 },
{ "clearEnvironmentVariable", "environment", "unset", 1, LegacyValue::AsGiven,
LegacyPhase::Any, LegacyMirror::Unset },
{ "clearEnvironmentVariables", "environment", "clear", 0, LegacyValue::AsGiven,
LegacyPhase::Any, LegacyMirror::Clear },
{ "setGlobalVariable", "globals", "set", 2, LegacyValue::Stringified,
LegacyPhase::Any, LegacyMirror::Set },
{ "getGlobalVariable", "globals", "get", 1 },
{ "clearGlobalVariable", "globals", "unset", 1, LegacyValue::AsGiven,
LegacyPhase::Any, LegacyMirror::Unset },
{ "clearGlobalVariables", "globals", "clear", 0, LegacyValue::AsGiven,
LegacyPhase::Any, LegacyMirror::Clear },
{ "setNextRequest", "execution", "setNextRequest", 1 },
{ "getResponseHeader", "response.headers", "get", 1, LegacyValue::AsGiven, LegacyPhase::Response },
});

constexpr bool arities_fit () {
    for (const auto& alias : LEGACY_ALIASES) {
        if (alias.arity < 0 || alias.arity > MAX_LEGACY_ARITY) {
            return false;
        }
    }
    return true;
}
static_assert (arities_fit (), "an alias passes on more arguments than js_legacy_alias holds");

/// The `environment` and `globals` globals, each an owned reference.
struct ScopeSnapshots {
    JSValue environment = JS_UNDEFINED;
    JSValue globals     = JS_UNDEFINED;
};

/**
 * Postman's legacy setters store `value.toString()` for a truthy value that
 * has one, where `pm.environment.set` keeps the value itself: so
 * `setEnvironmentVariable("n", 5)` reads back the string "5" and an object
 * reads back "[object Object]". `false`, `0`, `""`, `null` and `undefined` are
 * passed on as they are. The returned value is the caller's to free.
 */
JSValue legacy_stored_value (JSContext* ctx, JSValueConst value) {
    if (JS_ToBool (ctx, value) <= 0) {
        return JS_DupValue (ctx, value);
    }
    ScopedValue to_string (ctx, JS_GetPropertyStr (ctx, value, "toString"));
    if (JS_IsException (to_string.get ())) {
        return JS_EXCEPTION;
    }
    if (!JS_IsFunction (ctx, to_string.get ())) {
        return JS_DupValue (ctx, value);
    }
    return JS_Call (ctx, to_string.get (), value, 0, nullptr);
}

/// Deletes the property @p key names from @p snapshot. -1 with an exception
/// pending when the key cannot be turned into a property name.
int delete_snapshot_entry (JSContext* ctx, JSValueConst snapshot, JSValueConst key) {
    const JSAtom atom = JS_ValueToAtom (ctx, key);
    if (atom == JS_ATOM_NULL) {
        return -1;
    }
    const int deleted = JS_DeleteProperty (ctx, snapshot, atom, 0);
    JS_FreeAtom (ctx, atom);
    return deleted < 0 ? -1 : 0;
}

/// Postman's `__environment[key] = value`, its `key && delete
/// __environment[key]` and its delete-every-own-property, applied to the
/// snapshot before the scope is written, in Postman's order. -1 with an
/// exception pending on failure.
int mirror_into_snapshot (JSContext* ctx,
LegacyMirror mirror,
JSValueConst snapshot,
const std::array<JSValue, MAX_LEGACY_ARITY>& args) {
    switch (mirror) {
    case LegacyMirror::None: return 0;
    case LegacyMirror::Set: {
        const JSAtom atom = JS_ValueToAtom (ctx, args.at (0));
        if (atom == JS_ATOM_NULL) {
            return -1;
        }
        const int set =
        JS_SetProperty (ctx, snapshot, atom, JS_DupValue (ctx, args.at (1)));
        JS_FreeAtom (ctx, atom);
        return set < 0 ? -1 : 0;
    }
    case LegacyMirror::Unset:
        return JS_ToBool (ctx, args.at (0)) > 0 ?
        delete_snapshot_entry (ctx, snapshot, args.at (0)) :
        0;
    case LegacyMirror::Clear: {
        std::vector<std::string> keys;
        if (!js_own_enumerable_keys (ctx, snapshot, keys)) {
            return -1;
        }
        for (const auto& key : keys) {
            ScopedValue name (ctx, JS_NewStringLen (ctx, key.data (), key.size ()));
            if (delete_snapshot_entry (ctx, snapshot, name.get ()) < 0) {
                return -1;
            }
        }
        return 0;
    }
    }
    return 0;
}

// One `postman.*` method. @p magic indexes LEGACY_ALIASES; `data[0]` is the
// `pm` method, `data[1]` the object it is called on and `data[2]` the scope
// snapshot it writes through to (undefined for a method that writes none), all
// read when the `postman` object was built, so a script that reassigns `pm`,
// one of its members or the snapshot's global does not redirect the legacy
// call. QuickJS pads `argv` to the arity the function was created with, so
// reading up to it is safe.
JSValue js_legacy_alias (JSContext* ctx,
JSValueConst /*this_val*/,
int /*argc*/,
JSValueConst* argv,
int magic,
JSValueConst* data) {
    const LegacyAlias& alias = LEGACY_ALIASES.at (static_cast<std::size_t> (magic));
    std::array<JSValue, MAX_LEGACY_ARITY> args{ JS_UNDEFINED, JS_UNDEFINED };
    for (int i = 0; i < alias.arity; ++i) {
        args.at (static_cast<std::size_t> (i)) = JS_DupValue (ctx, argv[i]);
    }
    bool ready = true;
    if (alias.value == LegacyValue::Stringified) {
        JSValue stored = legacy_stored_value (ctx, args.at (1));
        JS_FreeValue (ctx, args.at (1));
        args.at (1) = stored;
        ready       = !JS_IsException (stored);
    }
    if (ready && JS_IsObject (data[2])) {
        ready = mirror_into_snapshot (ctx, alias.mirror, data[2], args) == 0;
    }
    JSValue result =
    ready ? JS_Call (ctx, data[0], data[1], alias.arity, args.data ()) : JS_EXCEPTION;
    for (JSValue arg : args) {
        JS_FreeValue (ctx, arg);
    }
    return result;
}

/// The member at dotted @p path under @p pm, or undefined. An owned reference.
JSValue pm_member (JSContext* ctx, JSValueConst pm, std::string_view path) {
    JSValue at = JS_DupValue (ctx, pm);
    while (!path.empty ()) {
        const std::size_t dot = path.find ('.');
        const std::string segment (path.substr (0, dot));
        path = dot == std::string_view::npos ? std::string_view{} : path.substr (dot + 1);
        JSValue next = JS_GetPropertyStr (ctx, at, segment.c_str ());
        JS_FreeValue (ctx, at);
        at = next;
    }
    return at;
}

/// The snapshot a method of @p owner writes through to, or undefined.
JSValueConst snapshot_of (const ScopeSnapshots& snapshots, std::string_view owner) {
    if (owner == "environment") {
        return snapshots.environment;
    }
    if (owner == "globals") {
        return snapshots.globals;
    }
    return JS_UNDEFINED;
}

void install_alias (JSContext* ctx,
JSValue postman,
JSValueConst pm,
const ScopeSnapshots& snapshots,
std::size_t index) {
    const LegacyAlias& alias = LEGACY_ALIASES.at (index);
    std::array<JSValue, 3> target{};
    target.at (1) = pm_member (ctx, pm, alias.owner);
    target.at (0) = JS_GetPropertyStr (ctx, target.at (1), alias.method);
    target.at (2) = alias.mirror == LegacyMirror::None ?
    JS_UNDEFINED :
    JS_DupValue (ctx, snapshot_of (snapshots, alias.owner));
    // JS_NewCFunctionData2 takes references of its own to the data.
    JS_SetPropertyStr (ctx, postman, alias.name,
    JS_NewCFunctionData2 (ctx, js_legacy_alias, alias.name, alias.arity,
    static_cast<int> (index), static_cast<int> (target.size ()), target.data ()));
    for (JSValue value : target) {
        JS_FreeValue (ctx, value);
    }
}

void install_postman (JSContext* ctx,
JSValue global,
JSValueConst pm,
const ScopeSnapshots& snapshots,
bool has_response) {
    JSValue postman = JS_NewObject (ctx);
    for (std::size_t i = 0; i < LEGACY_ALIASES.size (); ++i) {
        if (LEGACY_ALIASES.at (i).phase == LegacyPhase::Response && !has_response) {
            continue;
        }
        install_alias (ctx, postman, pm, snapshots, i);
    }
    // Postman's `cookies.one(name)`, which `pm.cookies` has no member for.
    if (has_response) {
        JS_SetPropertyStr (ctx, postman, "getResponseCookie",
        JS_NewCFunction (ctx, js_jar_cookies_one, "getResponseCookie", 1));
    }
    JS_SetPropertyStr (ctx, global, "postman", postman);
}

/**
 * `pm.<owner>.<method>()` as an owned reference, or undefined where `pm` has no
 * such owner (`pm.iterationData` outside a data-driven run). The methods called
 * are the engine's own readers, which throw only when the runtime is out of
 * memory; the exception is cleared rather than left pending into a script that
 * has not started, and the global reads as absent.
 */
JSValue call_pm (JSContext* ctx, JSValueConst pm, std::string_view owner, const char* method) {
    ScopedValue target (ctx, pm_member (ctx, pm, owner));
    if (!JS_IsObject (target.get ())) {
        return JS_UNDEFINED;
    }
    ScopedValue function (ctx, JS_GetPropertyStr (ctx, target.get (), method));
    JSValue result = JS_Call (ctx, function.get (), target.get (), 0, nullptr);
    if (JS_IsException (result)) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return JS_UNDEFINED;
    }
    return result;
}

/// @p value, or a new empty object in its place when it is not an object:
/// Postman's `execution.data || {}`. Takes ownership of @p value.
JSValue object_or_empty (JSContext* ctx, JSValue value) {
    if (JS_IsObject (value)) {
        return value;
    }
    JS_FreeValue (ctx, value);
    return JS_NewObject (ctx);
}

/**
 * Names to one value or, once a name repeats, the array of its values, in
 * first-seen order: Postman's `PropertyList#toObject` with multiple values,
 * and its form readers' accumulator.
 */
class MultiValueObject {
    public:
    /// How a repeated name is read: always appended (a header list), or
    /// appended only after a non-empty value, as the form readers test the
    /// earlier value for truthiness and replace an empty one.
    enum class Repeat : std::uint8_t { Append, ReplaceEmpty };

    void add (const std::string& name, const std::string& value, Repeat repeat) {
        const auto [at, inserted] = index_.try_emplace (name, entries_.size ());
        if (inserted) {
            entries_.push_back ({ name, { value } });
            return;
        }
        auto& values = entries_.at (at->second).second;
        if (repeat == Repeat::ReplaceEmpty && values.size () == 1 &&
        values.front ().empty ()) {
            values.front () = value;
            return;
        }
        values.push_back (value);
    }

    [[nodiscard]] JSValue to_js (JSContext* ctx) const {
        JSValue out = JS_NewObject (ctx);
        for (const auto& [name, values] : entries_) {
            JS_SetPropertyStr (ctx, out, name.c_str (), values_to_js (ctx, values));
        }
        return out;
    }

    private:
    static JSValue values_to_js (JSContext* ctx, const std::vector<std::string>& values) {
        if (values.size () == 1) {
            return JS_NewStringLen (
            ctx, values.front ().data (), values.front ().size ());
        }
        JSValue list = JS_NewArray (ctx);
        uint32_t i   = 0;
        for (const auto& value : values) {
            JS_SetPropertyUint32 (
            ctx, list, i++, JS_NewStringLen (ctx, value.data (), value.size ()));
        }
        return list;
    }

    std::vector<std::pair<std::string, std::vector<std::string>>> entries_;
    std::map<std::string, std::size_t> index_;
};

/// `request.headers`: Postman's `headers.toObject(true, false, true, true)`,
/// so a name is lower-cased, an empty one is left out and a repeated one reads
/// as the array of its values.
JSValue legacy_request_headers (JSContext* ctx, const HeaderList& lines) {
    MultiValueObject headers;
    for (const auto& line : lines) {
        if (!line.name.empty ()) {
            headers.add (vayu::utils::ascii_lower (line.name), line.value,
            MultiValueObject::Repeat::Append);
        }
    }
    return headers.to_js (ctx);
}

/// `request.data`: a form body as an object of its enabled fields, a text body
/// as its text, and `{}` for no body, an empty one, a file and GraphQL, which
/// Postman's reader has no case for.
JSValue legacy_request_data (JSContext* ctx, const Body& body) {
    switch (body.mode) {
    case BodyMode::Form:
    case BodyMode::FormData: {
        MultiValueObject fields;
        for (const auto& field : body.fields) {
            if (field.enabled) {
                fields.add (field.key, field.value, MultiValueObject::Repeat::ReplaceEmpty);
            }
        }
        return fields.to_js (ctx);
    }
    case BodyMode::Json:
    case BodyMode::Text:
    case BodyMode::Xml:
    case BodyMode::JsonRpc:
        if (!body.content.empty ()) {
            return JS_NewStringLen (ctx, body.content.data (), body.content.size ());
        }
        return JS_NewObject (ctx);
    case BodyMode::None:
    case BodyMode::Binary:
    case BodyMode::GraphQL: return JS_NewObject (ctx);
    }
    return JS_NewObject (ctx);
}

void set_string (JSContext* ctx, JSValue object, const char* name, const std::string& value) {
    JS_SetPropertyStr (
    ctx, object, name, JS_NewStringLen (ctx, value.data (), value.size ()));
}

/// `request`: the request this script is about, in Postman's legacy shape,
/// or `{}` where there is none (a setup or teardown script).
JSValue legacy_request (JSContext* ctx, const ContextData& data) {
    JSValue request = JS_NewObject (ctx);
    if (data.request == nullptr) {
        return request;
    }
    if (data.request_id && !data.request_id->empty ()) {
        set_string (ctx, request, "id", *data.request_id);
    }
    if (data.request_name && !data.request_name->empty ()) {
        set_string (ctx, request, "name", *data.request_name);
    }
    JS_SetPropertyStr (ctx, request, "headers",
    legacy_request_headers (ctx, script_request_header_lines (data)));
    JS_SetPropertyStr (ctx, request, "method",
    JS_NewString (ctx, to_string (data.request->method)));
    set_string (ctx, request, "url", data.request->url);
    JS_SetPropertyStr (
    ctx, request, "data", legacy_request_data (ctx, data.request->body));
    return request;
}

/// `responseCode`: Postman's `response.details()`, in its member order.
JSValue legacy_response_code (JSContext* ctx, const Response& response) {
    JSValue code = JS_NewObject (ctx);
    set_string (ctx, code, "name", response_reason_phrase (response));
    // Postman fills this with http-reasons' paragraph about the status, which
    // Vayu does not carry; the empty string is Postman's own fallback.
    set_string (ctx, code, "detail", "");
    JS_SetPropertyStr (ctx, code, "code", JS_NewInt32 (ctx, response.status_code));
    set_string (ctx, code, "standardName", vayu::http::status_text (response.status_code));
    return code;
}

/// `responseHeaders`: each name as it arrived, the last line of a repeated one
/// winning, as Postman builds it. Where the send kept no lines (the load path)
/// the folded, lower-cased map is all there is.
JSValue legacy_response_headers (JSContext* ctx, const Response& response) {
    JSValue headers = JS_NewObject (ctx);
    if (response.header_lines.empty ()) {
        for (const auto& [name, value] : response.headers) {
            set_string (ctx, headers, name.c_str (), value);
        }
        return headers;
    }
    for (const auto& line : response.header_lines) {
        set_string (ctx, headers, line.name.c_str (), line.value);
    }
    return headers;
}

constexpr int COOKIES_GET = 0;
constexpr int COOKIES_SET = 1;

// `responseCookies`, `pm.cookies.all()` on its first read. An accessor that
// replaces itself with what it answers, as `pm.response.cookies` does: a
// script that never reads it never pays for the jar read, two reads answer the
// same array, and where there is no jar the read throws `pm.cookies`' own
// refusal rather than answering an empty list. An assignment replaces it as it
// would any global. `data[0]` is `pm.cookies.all` and `data[1]` `pm.cookies`,
// read when the globals were bound.
JSValue js_legacy_response_cookies (JSContext* ctx,
JSValueConst /*this_val*/,
int /*argc*/,
JSValueConst* argv,
int magic,
JSValueConst* data) {
    JSValue value = magic == COOKIES_SET ? JS_DupValue (ctx, argv[0]) :
                                           JS_Call (ctx, data[0], data[1], 0, nullptr);
    if (JS_IsException (value)) {
        return value;
    }
    ScopedValue global (ctx, JS_GetGlobalObject (ctx));
    if (JS_DefinePropertyValueStr (ctx, global.get (), "responseCookies",
        JS_DupValue (ctx, value), JS_PROP_C_W_E) < 0) {
        JS_FreeValue (ctx, value);
        return JS_EXCEPTION;
    }
    if (magic == COOKIES_SET) {
        JS_FreeValue (ctx, value);
        return JS_UNDEFINED;
    }
    return value;
}

void install_response_cookies (JSContext* ctx, JSValue global, JSValueConst pm) {
    std::array<JSValue, 2> all{};
    all.at (1)     = pm_member (ctx, pm, "cookies");
    all.at (0)     = JS_GetPropertyStr (ctx, all.at (1), "all");
    JSValue getter = JS_NewCFunctionData2 (ctx, js_legacy_response_cookies,
    "responseCookies", 0, COOKIES_GET, static_cast<int> (all.size ()), all.data ());
    JSValue setter = JS_NewCFunctionData2 (ctx, js_legacy_response_cookies,
    "responseCookies", 1, COOKIES_SET, static_cast<int> (all.size ()), all.data ());
    for (JSValue value : all) {
        JS_FreeValue (ctx, value);
    }
    const JSAtom name = JS_NewAtom (ctx, "responseCookies");
    // Takes the getter and setter references.
    JS_DefinePropertyGetSet (ctx, global, name, getter, setter,
    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom (ctx, name);
}

/// The globals a test script has and a pre-request script does not.
void install_response_globals (JSContext* ctx, JSValue global, JSValueConst pm, const Response& response) {
    JS_SetPropertyStr (ctx, global, "responseBody", call_pm (ctx, pm, "response", "text"));
    JS_SetPropertyStr (ctx, global, "responseCode", legacy_response_code (ctx, response));
    JS_SetPropertyStr (
    ctx, global, "responseHeaders", legacy_response_headers (ctx, response));
    JS_SetPropertyStr (
    ctx, global, "responseTime", pm_member (ctx, pm, "response.responseTime"));
    install_response_cookies (ctx, global, pm);
}

/// `environment` and `globals`, each `pm.<scope>.toObject()` when the script
/// starts. Answers a reference to each for the `postman` setters to write
/// through to.
ScopeSnapshots install_scope_snapshots (JSContext* ctx, JSValue global, JSValueConst pm) {
    ScopeSnapshots snapshots;
    snapshots.environment =
    object_or_empty (ctx, call_pm (ctx, pm, "environment", "toObject"));
    snapshots.globals = object_or_empty (ctx, call_pm (ctx, pm, "globals", "toObject"));
    JS_SetPropertyStr (ctx, global, "environment", JS_DupValue (ctx, snapshots.environment));
    JS_SetPropertyStr (ctx, global, "globals", JS_DupValue (ctx, snapshots.globals));
    return snapshots;
}

/// The globals every script has: `tests`, `data`, `iteration` and `request`.
void install_execution_globals (JSContext* ctx, JSValue global, JSValueConst pm, ContextData& data) {
    data.legacy_tests = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, global, "tests", JS_DupValue (ctx, data.legacy_tests));
    JS_SetPropertyStr (ctx, global, "data",
    object_or_empty (ctx, call_pm (ctx, pm, "iterationData", "toObject")));
    // Postman's `cursor.iteration`, 0 where there is no run to count.
    JS_SetPropertyStr (ctx, global, "iteration",
    JS_NewInt64 (ctx, static_cast<int64_t> (data.iteration.value_or (0))));
    JS_SetPropertyStr (ctx, global, "request", legacy_request (ctx, data));
}

/// One `tests[name] = value` row: passed when the value is truthy, failed
/// with Postman's own wording when it is not.
TestResult legacy_test_result (JSContext* ctx, JSValueConst tests, const std::string& name) {
    TestResult result;
    result.name = name;
    ScopedValue value (ctx, JS_GetPropertyStr (ctx, tests, name.c_str ()));
    if (JS_IsException (value.get ())) {
        // A getter the script defined on the object threw: that is the row's
        // verdict.
        ScopedValue thrown (ctx, JS_GetException (ctx));
        result.error_message = js_to_string (ctx, thrown.get ());
        return result;
    }
    result.passed = JS_ToBool (ctx, value.get ()) > 0;
    if (!result.passed) {
        // A falsy value is a primitive, so naming it runs no script code.
        result.error_message = "AssertionError: expected " +
        js_to_string (ctx, value.get ()) + " to be truthy";
    }
    return result;
}

} // namespace

void setup_postman_legacy (JSContext* ctx, JSValue global, JSValue pm) {
    auto* data = get_context_data (ctx);
    if (data == nullptr) {
        return;
    }
    const bool has_response = data->response != nullptr;
    install_execution_globals (ctx, global, pm, *data);
    const ScopeSnapshots snapshots = install_scope_snapshots (ctx, global, pm);
    if (has_response) {
        install_response_globals (ctx, global, pm, *data->response);
    }
    install_postman (ctx, global, pm, snapshots, has_response);
    JS_FreeValue (ctx, snapshots.environment);
    JS_FreeValue (ctx, snapshots.globals);
}

void record_legacy_tests (JSContext* ctx, ContextData& data) {
    if (!JS_IsObject (data.legacy_tests)) {
        return;
    }
    std::vector<std::string> names;
    if (!js_own_enumerable_keys (ctx, data.legacy_tests, names)) {
        // Only an exhausted runtime fails to list a plain object's keys; the
        // execution has its error already.
        JS_FreeValue (ctx, JS_GetException (ctx));
        return;
    }
    for (const auto& name : names) {
        data.tests.push_back (legacy_test_result (ctx, data.legacy_tests, name));
    }
}

} // namespace vayu::runtime::pm_detail
