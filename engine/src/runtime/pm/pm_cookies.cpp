/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_cookies.cpp
 * @brief `pm.cookies` (the jar) and `pm.response.cookies`.
 */

#include "pm_internal.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/set_cookie.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

// ============================================================================
// pm.response.cookies
// ============================================================================

// Methods hang off the list without being enumerable, so Object.keys() and a
// spread over it see cookies and nothing else.
constexpr int COOKIE_METHOD_FLAGS = JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE;

// Cookie names are case-sensitive (RFC 6265 §4.1.1) - unlike header names, so
// this is an exact match and not the ASCII fold header names compare under.
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

// One cookie per received `Set-Cookie` line when the response kept its lines
// (issue #2460), which is what makes a comma inside a value safe. A response
// without them - a trace stored before the field - falls back to splitting the
// folded map entry, where the comma heuristic is all there is.
std::vector<vayu::http::SetCookie> cookies_from_lines (
const std::vector<vayu::HeaderLine>& lines) {
    std::vector<vayu::http::SetCookie> cookies;
    for (const auto& line : lines) {
        if (!vayu::utils::ascii_lower_equal (line.name, "set-cookie")) {
            continue;
        }
        if (auto cookie = vayu::http::parse_set_cookie_line (line.value)) {
            cookies.push_back (std::move (*cookie));
        }
    }
    return cookies;
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
    if (!data->response->header_lines.empty ()) {
        return cookies_from_lines (data->response->header_lines);
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

} // namespace

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

namespace {

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

// The request's URL as the script's variables resolve it at this call. A
// request a pre-request script runs before keeps its `{{name}}`s written
// until the script ends (#2521), so its URL names no host while the script
// runs; the send will resolve it against what the script leaves, and the
// cookies and the site the jar answers for are that URL's, read the same way
// `pm.variables.replaceIn` reads it now. A name nothing answers keeps its
// braces, and a URL with one in its host names no site.
std::string jar_request_url (JSContext* ctx, const Request& request) {
    std::string missing_column;
    auto resolved = resolve_script_template (ctx, request.url, missing_column);
    return resolved ? std::move (*resolved) : request.url;
}

// The cookies that would be sent to the request this script belongs to -
// from the jar when there is one (design mode), from the read-only per-VU
// view an inline load-run script carries (issue #1501) otherwise. Returns
// nullopt having thrown: no context or request to match against, or neither
// source of cookies exists here, and each deserves its own sentence rather
// than an empty answer.
std::optional<std::vector<vayu::http::JarCookie>>
jar_cookies_from_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data || !data->request) {
        JS_ThrowInternalError (ctx, "No request available");
        return std::nullopt;
    }
    if (data->cookie_jar) {
        return vayu::http::matching_in (
        staged_jar_lines (*data), jar_request_url (ctx, *data->request));
    }
    if (data->cookie_read_lines) {
        return vayu::http::matching_in (
        *data->cookie_read_lines, jar_request_url (ctx, *data->request));
    }
    // A `%s` template picked at runtime defeats `-Wformat-nonliteral` even
    // where every candidate is itself a literal - the compiler cannot see
    // past the branch - so the substitution is done here, in C++, and the
    // format string `JS_ThrowPlainError` actually receives is the literal
    // "%s" below, exactly one call site holding all the runtime content.
    std::string refusal = data->cookie_read_refusal != nullptr ?
    data->cookie_read_refusal :
    "pm.cookies.%s is not available here: the cookie jar is a design-mode "
    "feature, and this execution has no jar to read. Use "
    "pm.response.cookies for the Set-Cookie of the response in hand. See "
    "docs/engine/scripting.md.";
    if (const auto placeholder = refusal.find ("%s"); placeholder != std::string::npos) {
        refusal.replace (placeholder, 2, member);
    }
    JS_ThrowPlainError (ctx, "%s", refusal.c_str ());
    return std::nullopt;
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

// A stored cookie as the object Postman's Cookie is - everything the jar keeps
// and nothing it does not. `maxAge` and the unmodelled extensions Postman
// carries have no field behind them here, and inventing one would hand a script
// a value it could read and act on.
JSValue create_jar_cookie_object (JSContext* ctx, const vayu::http::JarCookie& cookie) {
    JSValue obj = JS_NewObject (ctx);
    if (JS_IsException (obj)) {
        return obj;
    }
    JS_SetPropertyStr (ctx, obj, "name", JS_NewString (ctx, cookie.name.c_str ()));
    // Postman's Cookie spells the name `key` and keeps `name` beside it. A
    // script imported from there reads either, and the one that answered
    // undefined would do it silently.
    JS_SetPropertyStr (ctx, obj, "key", JS_NewString (ctx, cookie.name.c_str ()));
    JS_SetPropertyStr (ctx, obj, "value", JS_NewString (ctx, cookie.value.c_str ()));
    JS_SetPropertyStr (ctx, obj, "domain", JS_NewString (ctx, cookie.domain.c_str ()));
    JS_SetPropertyStr (ctx, obj, "path", JS_NewString (ctx, cookie.path.c_str ()));
    JS_SetPropertyStr (ctx, obj, "secure", JS_NewBool (ctx, cookie.secure));
    JS_SetPropertyStr (ctx, obj, "httpOnly", JS_NewBool (ctx, cookie.http_only));
    // The jar stores "does this answer for subdomains too"; Postman states the
    // same fact the other way round, and a script tests hostOnly.
    JS_SetPropertyStr (ctx, obj, "hostOnly", JS_NewBool (ctx, !cookie.include_subdomains));
    // A session cookie has no expiry rather than one at the epoch, so `expires`
    // is null there and `session` is what says which. Otherwise it is the Date
    // Postman's Cookie carries - and the Date jar().set now takes, so a cookie
    // read here can be written back without converting it.
    const bool session = cookie.expires == 0;
    JS_SetPropertyStr (ctx, obj, "session", JS_NewBool (ctx, session));
    JS_SetPropertyStr (ctx, obj, "expires",
    session ? JS_NULL : JS_NewDate (ctx, static_cast<double> (cookie.expires) * 1000.0));
    return obj;
}

// The matched cookies as a plain array. Postman hands back a CookieList, whose
// reads are the ones pm.cookies itself carries; an array is what both this
// engine's other cookie surface (pm.response.cookies) and every `for (const c
// of ...)` in an imported script treat it as.
JSValue create_jar_cookie_list (JSContext* ctx,
const std::vector<vayu::http::JarCookie>& cookies) {
    JSValue list = JS_NewArray (ctx);
    if (JS_IsException (list)) {
        return list;
    }
    uint32_t index = 0;
    for (const auto& cookie : cookies) {
        JSValue entry = create_jar_cookie_object (ctx, cookie);
        if (JS_IsException (entry)) {
            JS_FreeValue (ctx, list);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32 (ctx, list, index++, entry);
    }
    return list;
}

/// What a read of one named cookie answers with: its value, or the whole cookie
/// as `all()` lists it.
enum class NamedCookieForm : std::uint8_t { Value, Cookie };

// `pm.cookies.get(name)`, and Postman's `cookies.one(name)` behind
// `postman.getResponseCookie` - one lookup, so the two cannot pick different
// cookies for a name the jar holds twice.
JSValue read_named_jar_cookie (JSContext* ctx, int argc, JSValueConst* argv, NamedCookieForm form) {
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
    if (!cookie) {
        return JS_UNDEFINED;
    }
    return form == NamedCookieForm::Value ?
    JS_NewString (ctx, cookie->value.c_str ()) :
    create_jar_cookie_object (ctx, *cookie);
}

JSValue js_jar_cookies_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    return read_named_jar_cookie (ctx, argc, argv, NamedCookieForm::Value);
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

// The three PropertyList reads Postman's CookieList carries. They answer over
// the same matched set get/has/toObject answer over, read afresh per call: the
// flat pm.cookies is an accessor onto a jar a jar().set can change mid-script,
// so a list built once and kept would answer with the set as it was.
JSValue js_jar_cookies_all (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto cookies = jar_cookies_from_context (ctx, "all");
    if (!cookies) {
        return JS_EXCEPTION;
    }
    return create_jar_cookie_list (ctx, *cookies);
}

JSValue js_jar_cookies_count (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto cookies = jar_cookies_from_context (ctx, "count");
    if (!cookies) {
        return JS_EXCEPTION;
    }
    return JS_NewInt64 (ctx, static_cast<int64_t> (cookies->size ()));
}

JSValue js_jar_cookies_each (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "pm.cookies.each(fn) needs a function, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    auto cookies = jar_cookies_from_context (ctx, "each");
    if (!cookies) {
        return JS_EXCEPTION;
    }
    // PropertyList.each takes the iterator's `this` as its second argument.
    JSValue receiver = argc > 1 ? argv[1] : JS_UNDEFINED;
    for (const auto& cookie : *cookies) {
        ScopedValue entry (ctx, create_jar_cookie_object (ctx, cookie));
        if (JS_IsException (entry.get ())) {
            return JS_EXCEPTION;
        }
        JSValue args[1] = { entry.get () };
        // A throw from the iterator - a failed pm.expect inside it, most
        // likely - is the script's error and ends the walk, rather than being
        // swallowed to finish iterating.
        ScopedValue ret (ctx, JS_Call (ctx, argv[0], receiver, 1, args));
        if (JS_IsException (ret.get ())) {
            return JS_EXCEPTION;
        }
    }
    return JS_UNDEFINED;
}

// ----------------------------------------------------------------------------
// pm.cookies.jar() - the write half (issue #337)
// ----------------------------------------------------------------------------

// The context of a script that may stage a jar write, or nullptr having
// thrown. A jar with nowhere to apply writes is refused rather than silently
// accepted: a call that reported success for a cookie that went nowhere is the
// failure this whole surface exists to avoid.
ContextData* jar_write_context (JSContext* ctx, const char* member) {
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
    return data;
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

// Milliseconds since the epoch out of a JS value that is either a Date or the
// result of Date.parse, or nullopt for an Invalid Date. Any pending exception
// is cleared: this reports its outcome as a refusal reason, which the caller
// throws, and a second exception left standing behind that one would be the
// error a script sees.
std::optional<double> js_epoch_milliseconds (JSContext* ctx, JSValue millis) {
    ScopedValue held (ctx, millis);
    if (JS_IsException (held.get ())) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return std::nullopt;
    }
    double value = 0;
    if (JS_ToFloat64 (ctx, &value, held.get ()) < 0) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return std::nullopt;
    }
    // An Invalid Date - `new Date("not a date")` - is NaN rather than a throw.
    return std::isfinite (value) ? std::optional<double> (value) : std::nullopt;
}

// What a script wrote in `expires`, as the seconds since the epoch the jar
// stores. Three spellings, because Postman takes all three: a number of
// seconds, a Date, and a date string.
//
// The Date and the string are read by asking QuickJS's own Date - `getTime`
// and `Date.parse` - rather than parsing text here. A date parser beside the
// language's own would answer differently from the `new Date(s)` the same
// script can write two lines up, and the disagreement would show as a cookie
// that expires in 1970 and is simply never sent again.
std::optional<std::string>
read_expires_seconds (JSContext* ctx, JSValueConst value, int64_t& out) {
    const std::string prefix = "pm.cookies.jar().set cookie.expires ";
    // Every arm below either returns a reason or sets this, so the checks
    // after them read a value all three agree on rather than three copies.
    double seconds = 0;

    if (JS_IsNumber (value)) {
        double written = 0;
        if (JS_ToFloat64 (ctx, &written, value) < 0 || !std::isfinite (written)) {
            JS_FreeValue (ctx, JS_GetException (ctx));
            return prefix + "must be a finite number of seconds since the epoch";
        }
        // A number is seconds exactly as written, and a fractional one is
        // refused rather than truncated: `getTime() / 1000` without the floor
        // is the shape it arrives in, and this surface refuses everywhere else
        // it cannot be sure. The message names both cures.
        if (written != std::floor (written)) {
            return prefix +
            "is not a whole number of seconds; pass a Date, or "
            "Math.floor(date.getTime() / 1000)";
        }
        seconds = written;
    } else if (JS_IsDate (value)) {
        // Not JS_ToFloat64 on the Date itself: its @@toPrimitive takes the
        // default hint as "string", so a Date coerces to NaN rather than to
        // its time. getTime is what the script would have called.
        ScopedValue get_time (ctx, JS_GetPropertyStr (ctx, value, "getTime"));
        const auto millis = js_epoch_milliseconds (
        ctx, JS_Call (ctx, get_time.get (), value, 0, nullptr));
        if (!millis) {
            return prefix + "is an Invalid Date";
        }
        seconds = std::floor (*millis / 1000.0);
    } else if (JS_IsString (value)) {
        const std::string text = js_to_string (ctx, value);
        ScopedValue global (ctx, JS_GetGlobalObject (ctx));
        ScopedValue date (ctx, JS_GetPropertyStr (ctx, global.get (), "Date"));
        ScopedValue parse (ctx, JS_GetPropertyStr (ctx, date.get (), "parse"));
        ScopedValue arg (ctx, JS_NewString (ctx, text.c_str ()));
        JSValue args[1]   = { arg.get () };
        const auto millis = js_epoch_milliseconds (
        ctx, JS_Call (ctx, parse.get (), date.get (), 1, args));
        if (!millis) {
            return prefix + "is not a date this engine can read: \"" + text +
            "\". Date.parse must accept it - an ISO 8601 or HTTP date does.";
        }
        seconds = std::floor (*millis / 1000.0);
    } else {
        return prefix +
        "must be a number of seconds since the epoch, a Date, "
        "or a date string, got " +
        std::string (js_type_name (ctx, value));
    }

    if (seconds < 0) {
        return prefix + "must not be before the epoch; 0 means a session cookie";
    }
    // The jar stores an int64_t, and a double past its range converts as
    // undefined behaviour rather than as a large number.
    if (seconds > static_cast<double> (std::numeric_limits<int64_t>::max ())) {
        return prefix + "is further in the future than the jar can store";
    }
    out = static_cast<int64_t> (seconds);
    return std::nullopt;
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
        if (auto reason = read_expires_seconds (ctx, js_expires.get (), out.expires)) {
            return reason;
        }
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

// The one definition of the sites a script's jar access may name (#2358,
// #2631): the request's own, and any host it has addressed through
// pm.sendRequest, each matched in both directions (`hosts_domain_related`) so a
// `Domain=` cookie is reachable from a subdomain and a subdomain's from the
// apex. Reads and writes both ask it, so they cannot drift. Without the limit
// a script could read the session the environment's jar holds for any host, or
// plant and delete a cookie for one. Only the request URL and the
// pm.sendRequest URLs are seen: a redirect's target is not, so a redirect does
// not widen the scope.
std::optional<std::string> jar_request_host (JSContext* ctx, const ContextData& data) {
    if (!data.request) {
        return std::nullopt;
    }
    return vayu::http::cookie_scope_host (jar_request_url (ctx, *data.request));
}

bool jar_host_in_scope (JSContext* ctx, const ContextData& data, const std::string& host) {
    const auto related = [&host] (const std::string& allowed) {
        return vayu::http::hosts_domain_related (host, allowed);
    };
    const auto request_host = jar_request_host (ctx, data);
    return (request_host && related (*request_host)) ||
    std::ranges::any_of (data.addressed_hosts, related);
}

// One console warning for a refusal: @p outcome says what did not happen, the
// rest names the scope. It names hosts, never a URL (which may carry a secret)
// or a cookie value.
void warn_out_of_jar_scope (JSContext* ctx,
ContextData& data,
const char* access,
const std::string& outcome) {
    const auto request_host = jar_request_host (ctx, data);
    data.add_console_entry (ConsoleLevel::Warn,
    outcome + ": a jar " + access + " is limited to the request's own site" +
    (request_host ? " (" + *request_host + ")" : std::string{}) +
    " and to hosts this script has called through pm.sendRequest. See "
    "docs/engine/scripting.md.");
}

// Whether a jar read of @p url stays inside the scope. A URL libcurl reads no
// host from is let through, as there is nothing to match and `matching_in`
// answers empty for it anyway. A refusal leaves one console warning.
bool jar_read_in_scope (JSContext* ctx, ContextData& data, const char* member, const std::string& url) {
    const auto host = vayu::http::cookie_scope_host (url);
    if (!host || jar_host_in_scope (ctx, data, *host)) {
        return true;
    }
    warn_out_of_jar_scope (ctx, data, "read",
    std::string ("pm.cookies.") + member + " read nothing for " + *host);
    return false;
}

// Whether a jar write naming @p url stays inside the scope: the same rule a
// read of it is held to, so `unset` and `clear(url)` cannot delete what `get`
// cannot see. A refused write stages nothing.
bool jar_write_in_scope (JSContext* ctx, ContextData& data, const char* member, const std::string& url) {
    const auto host = vayu::http::cookie_scope_host (url);
    if (!host || jar_host_in_scope (ctx, data, *host)) {
        return true;
    }
    warn_out_of_jar_scope (ctx, data, "write",
    std::string ("pm.cookies.") + member + " wrote nothing for " + *host);
    return false;
}

// Whether @p host is, spelled exactly, the request's host or one this script
// has addressed: the one case a single-label domain may be written for.
bool jar_host_is_scope_host (JSContext* ctx, const ContextData& data, const std::string& host) {
    const auto request_host = jar_request_host (ctx, data);
    const auto same         = [&host] (const std::string& allowed) {
        return vayu::utils::ascii_lower_equal (host, allowed);
    };
    return (request_host && same (*request_host)) ||
    std::ranges::any_of (data.addressed_hosts, same);
}

// A domain with no interior dot (`com`, `test`) is a top-level domain, and a
// cookie for one is carried to every site under it. There is no public-suffix
// list to tell `co.uk` from `example.co.uk`, so this is the cheap half of the
// rule; an IPv6 literal is exact by nature and exempt.
bool is_single_label_domain (const std::string& host) {
    return !host.starts_with ("[") && host.find ('.') == std::string::npos;
}

// Whether a cookie about to be stored for @p domain (as `cookie_for_url`
// settled it: punycode, a leading dot for "subdomains too") stays inside the
// scope. This is the half `jar_write_in_scope` cannot see: a cookie whose
// Domain differs from the URL's host is sent to that domain's hosts, so the
// URL being in scope proves nothing about where the cookie goes. The scope
// relates a host to its parents, so a single-label domain is held to the exact
// host (`localhost` writing `localhost`) rather than to the parent test.
bool jar_cookie_domain_in_scope (JSContext* ctx,
ContextData& data,
const char* member,
const std::string& domain) {
    const std::string host = domain.starts_with (".") ? domain.substr (1) : domain;
    const bool suffix_like =
    is_single_label_domain (host) && !jar_host_is_scope_host (ctx, data, host);
    if (!suffix_like && jar_host_in_scope (ctx, data, host)) {
        return true;
    }
    const std::string outcome =
    std::string ("pm.cookies.") + member + " wrote nothing for the domain " + host;
    if (suffix_like) {
        data.add_console_entry (ConsoleLevel::Warn,
        outcome +
        ": a single-label domain is refused unless it is the request's "
        "own host, as it would reach every site under it. See "
        "docs/engine/scripting.md.");
    } else {
        warn_out_of_jar_scope (ctx, data, "write", outcome);
    }
    return false;
}

// The cookies a jar read of @p url answers with, staged writes applied;
// nothing for a site `jar_read_in_scope` refuses.
std::vector<vayu::http::JarCookie>
jar_read (JSContext* ctx, ContextData& data, const char* member, const std::string& url) {
    if (!jar_read_in_scope (ctx, data, member, url)) {
        return {};
    }
    return vayu::http::matching_in (staged_jar_lines (data), url);
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

    const auto cookies = jar_read (ctx, *data, "jar().get", *url);
    const auto* cookie = find_jar_cookie (cookies, *name);
    return finish_jar_call (ctx, argc, argv, 2,
    cookie ? JS_NewString (ctx, cookie->value.c_str ()) : JS_UNDEFINED);
}

// Postman's "dump the session" read: every cookie that URL would carry, rather
// than the one that answers for a name. The same walk get() makes, without the
// name to narrow it - so the matching, the staged writes it sees and the jar's
// per-environment isolation are get()'s, not a second set of rules.
JSValue js_jar_get_all (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto url = read_jar_string_arg (ctx, "getAll", "URL", 0, argc, argv, /*url_arg=*/true);
    if (!url) {
        return JS_EXCEPTION;
    }
    auto* data = jar_context (ctx, "jar().getAll");
    if (!data) {
        return JS_EXCEPTION;
    }

    const auto cookies = jar_read (ctx, *data, "jar().getAll", *url);
    JSValue list       = create_jar_cookie_list (ctx, cookies);
    if (JS_IsException (list)) {
        return list;
    }
    return finish_jar_call (ctx, argc, argv, 1, list);
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

    auto* data = jar_write_context (ctx, "jar().set");
    if (!data) {
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
    // Refused after validation, so a bad argument is still the error it was; a
    // refusal is a warning and the call completes as a stored write would.
    if (jar_write_in_scope (ctx, *data, "jar().set", *url) &&
    jar_cookie_domain_in_scope (ctx, *data, "jar().set", stored->domain)) {
        data->cookie_writes->push_back ({ vayu::http::CookieWrite::Kind::Set,
        vayu::http::format_cookie_line (*stored), {}, {} });
    }
    // Postman hands the callback the cookie it stored, which is the one thing
    // this call knows and the script does not: the domain and path it took
    // from the URL, where the object left them out.
    return finish_jar_call (
    ctx, argc, argv, callback_index, create_jar_cookie_object (ctx, *stored));
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
    auto* data = jar_write_context (ctx, "jar().unset");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (jar_write_in_scope (ctx, *data, "jar().unset", *url)) {
        data->cookie_writes->push_back (
        { vayu::http::CookieWrite::Kind::Unset, {}, std::move (*url), *name });
    }
    // The removed name, where set hands back the stored cookie. There is no
    // cookie left to describe, and Postman's own callback carries nothing at
    // all here - a name is the most this can honestly report.
    return finish_jar_call (ctx, argc, argv, 2, JS_NewString (ctx, name->c_str ()));
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

    auto* data = jar_write_context (ctx, "jar().clear");
    if (!data) {
        return JS_EXCEPTION;
    }
    auto* writes = data->cookie_writes;
    if (url) {
        // Scoped exactly as unset is - the cookies a request to this URL would
        // have carried - so the two spellings cannot disagree about what "this
        // URL's cookies" are, nor about which sites a script may clear.
        if (jar_write_in_scope (ctx, *data, "jar().clear", *url)) {
            writes->push_back (
            { vayu::http::CookieWrite::Kind::ClearUrl, {}, std::move (*url), {} });
        }
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
    JS_SetPropertyStr (
    ctx, jar, "getAll", JS_NewCFunction (ctx, js_jar_get_all, "getAll", 2));
    JS_SetPropertyStr (ctx, jar, "set", JS_NewCFunction (ctx, js_jar_set, "set", 4));
    JS_SetPropertyStr (ctx, jar, "unset", JS_NewCFunction (ctx, js_jar_unset, "unset", 3));
    JS_SetPropertyStr (ctx, jar, "clear", JS_NewCFunction (ctx, js_jar_clear, "clear", 2));
    return jar;
}

} // namespace

JSValue js_jar_cookies_one (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    return read_named_jar_cookie (ctx, argc, argv, NamedCookieForm::Cookie);
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
    ctx, cookies, "each", JS_NewCFunction (ctx, js_jar_cookies_each, "each", 2));
    JS_SetPropertyStr (
    ctx, cookies, "all", JS_NewCFunction (ctx, js_jar_cookies_all, "all", 0));
    JS_SetPropertyStr (ctx, cookies, "count",
    JS_NewCFunction (ctx, js_jar_cookies_count, "count", 0));
    JS_SetPropertyStr (
    ctx, cookies, "jar", JS_NewCFunction (ctx, js_cookies_jar, "jar", 0));
    JS_SetPropertyStr (ctx, pm, "cookies", cookies);
}

} // namespace vayu::runtime::pm_detail
