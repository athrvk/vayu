/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_legacy.cpp
 * @brief The `postman` global: Postman's pre-`pm.*` helper methods (#2577).
 *
 * Each method is an alias of the `pm` member Postman itself names as its
 * replacement (`LEGACY_GLOBS_ALTERNATIVES` in postman-sandbox), so a legacy
 * call and its `pm.*` spelling cannot answer differently. The shape follows
 * postman-sandbox's `lib/sandbox/postman-legacy-interface.js`: every method
 * passes on exactly the arguments Postman's does, the two setters stringify
 * their value first, and the two response readers exist only where there is a
 * response.
 */

#include "pm_internal.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace vayu::runtime::pm_detail {
namespace {

/// Whether an alias passes its value argument on as given, or first turns it
/// into the string Postman's legacy setters store.
enum class LegacyValue : std::uint8_t { AsGiven, Stringified };

/// Where a method exists: in every script, or only where there is a response.
enum class LegacyPhase : std::uint8_t { Any, Response };

struct LegacyAlias {
    const char* name;  ///< the member of `postman`
    const char* owner; ///< the `pm` member, dotted, the target is a method of
    const char* method;
    int arity; ///< how many arguments Postman's method passes on
    LegacyValue value = LegacyValue::AsGiven;
    LegacyPhase phase = LegacyPhase::Any;
};

constexpr int MAX_LEGACY_ARITY = 2;

constexpr auto LEGACY_ALIASES = std::to_array<LegacyAlias> ({
{ "setEnvironmentVariable", "environment", "set", 2, LegacyValue::Stringified },
{ "getEnvironmentVariable", "environment", "get", 1 },
{ "clearEnvironmentVariable", "environment", "unset", 1 },
{ "clearEnvironmentVariables", "environment", "clear", 0 },
{ "setGlobalVariable", "globals", "set", 2, LegacyValue::Stringified },
{ "getGlobalVariable", "globals", "get", 1 },
{ "clearGlobalVariable", "globals", "unset", 1 },
{ "clearGlobalVariables", "globals", "clear", 0 },
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

// One `postman.*` method. @p magic indexes LEGACY_ALIASES; `data[0]` is the
// `pm` method and `data[1]` the object it is called on, both read when the
// `postman` object was built, so a script that reassigns `pm` or one of its
// members does not redirect the legacy call. QuickJS pads `argv` to the arity
// the function was created with, so reading up to it is safe.
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

void install_alias (JSContext* ctx, JSValue postman, JSValueConst pm, std::size_t index) {
    const LegacyAlias& alias = LEGACY_ALIASES.at (index);
    std::array<JSValue, 2> target{};
    target.at (1) = pm_member (ctx, pm, alias.owner);
    target.at (0) = JS_GetPropertyStr (ctx, target.at (1), alias.method);
    // JS_NewCFunctionData2 takes references of its own to the data.
    JS_SetPropertyStr (ctx, postman, alias.name,
    JS_NewCFunctionData2 (ctx, js_legacy_alias, alias.name, alias.arity,
    static_cast<int> (index), static_cast<int> (target.size ()), target.data ()));
    for (JSValue value : target) {
        JS_FreeValue (ctx, value);
    }
}

} // namespace

void setup_postman_legacy (JSContext* ctx, JSValue global, JSValue pm) {
    const auto* data        = get_context_data (ctx);
    const bool has_response = data != nullptr && data->response != nullptr;
    JSValue postman         = JS_NewObject (ctx);
    for (std::size_t i = 0; i < LEGACY_ALIASES.size (); ++i) {
        if (LEGACY_ALIASES.at (i).phase == LegacyPhase::Response && !has_response) {
            continue;
        }
        install_alias (ctx, postman, pm, i);
    }
    // Postman's `cookies.one(name)`, which `pm.cookies` has no member for.
    if (has_response) {
        JS_SetPropertyStr (ctx, postman, "getResponseCookie",
        JS_NewCFunction (ctx, js_jar_cookies_one, "getResponseCookie", 1));
    }
    JS_SetPropertyStr (ctx, global, "postman", postman);
}

} // namespace vayu::runtime::pm_detail
