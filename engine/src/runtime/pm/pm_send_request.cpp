/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_send_request.cpp
 * @brief `pm.sendRequest`.
 */

#include "pm_internal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "vayu/core/url_encoding.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

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

// A form row's key or value: a string, or the number or boolean a script
// interpolated into one.
std::optional<std::string>
read_form_text (JSContext* ctx, JSValueConst value, const std::string& what, std::string& out) {
    if (!JS_IsString (value) && !JS_IsNumber (value) && !JS_IsBool (value)) {
        return what + " must be a string, got " + std::string (js_type_name (ctx, value));
    }
    out = js_to_string (ctx, value);
    return std::nullopt;
}

// One `{ key, value, disabled?, contentType? }` row of a form body's array
// form. A file part (`type: 'file'`, carrying a `src` and no value) is refused
// by name: the sandbox has no grant to read a file from disk with, and sending
// the part without its file is the silent wrong request.
std::optional<std::string>
read_form_entry (JSContext* ctx, JSValueConst entry, const std::string& where, FormField& out) {
    if (!JS_IsObject (entry) || JS_IsArray (entry) || JS_IsFunction (ctx, entry)) {
        return where + " entries must be { key, value } objects, got " +
        std::string (js_type_name (ctx, entry));
    }
    ScopedValue key (ctx, JS_GetPropertyStr (ctx, entry, "key"));
    if (!JS_IsString (key.get ())) {
        return where + " entries need a string 'key', got " +
        std::string (js_type_name (ctx, key.get ()));
    }
    out.key = js_to_string (ctx, key.get ());

    ScopedValue type (ctx, JS_GetPropertyStr (ctx, entry, "type"));
    if (JS_IsString (type.get ()) && js_to_string (ctx, type.get ()) == "file") {
        return where + " '" + out.key +
        "' is a file part - pm.sendRequest sends text parts only, and a file "
        "part cannot be sent from a script";
    }
    ScopedValue value (ctx, JS_GetPropertyStr (ctx, entry, "value"));
    if (auto reason = read_form_text (
        ctx, value.get (), where + " '" + out.key + "' value", out.value)) {
        return reason;
    }

    ScopedValue content_type (ctx, JS_GetPropertyStr (ctx, entry, "contentType"));
    if (JS_IsString (content_type.get ())) {
        out.content_type = js_to_string (ctx, content_type.get ());
    }
    ScopedValue disabled (ctx, JS_GetPropertyStr (ctx, entry, "disabled"));
    out.enabled = JS_ToBool (ctx, disabled.get ()) <= 0;
    return std::nullopt;
}

// A form body's rows, in either shape Postman accepts: an array of
// `{ key, value, disabled? }` as an exported collection carries it, or a plain
// `{ name: value }` object as a script hand-writes it. Both, for the reason the
// header option reads both - a row silently vanishing is a request sent short.
// A disabled row is validated and then left out, which is what disabled means
// on the wire (`enabled_fields`).
std::optional<std::string> read_form_fields (JSContext* ctx,
JSValueConst list,
const std::string& where,
std::vector<FormField>& out) {
    if (JS_IsArray (list)) {
        int64_t length = 0;
        if (JS_GetLength (ctx, list, &length) < 0) {
            return where + " could not be enumerated";
        }
        for (int64_t i = 0; i < length; i++) {
            ScopedValue entry (ctx, JS_GetPropertyInt64 (ctx, list, i));
            FormField field;
            if (auto reason = read_form_entry (ctx, entry.get (), where, field)) {
                return reason;
            }
            if (field.enabled) {
                out.push_back (std::move (field));
            }
        }
        return std::nullopt;
    }

    std::vector<std::string> names;
    if (!JS_IsObject (list) || JS_IsFunction (ctx, list) ||
    !js_own_enumerable_keys (ctx, list, names)) {
        return where + " must be an array of { key, value } entries or an object, got " +
        std::string (js_type_name (ctx, list));
    }
    for (const auto& name : names) {
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, list, name.c_str ()));
        FormField field;
        field.key = name;
        if (auto reason = read_form_text (
            ctx, value.get (), where + " '" + name + "' value", field.value)) {
            return reason;
        }
        out.push_back (std::move (field));
    }
    return std::nullopt;
}

// `{ mode: 'urlencoded', urlencoded: [...] }` or the `formdata` pair. The rows
// become the body's fields and the send path's own encoders do the rest
// (`encode_urlencoded`, libcurl's multipart), with the Content-Type they imply
// unless the script's headers name one. Serialising here instead would copy the
// encoders and miss the multipart boundary.
std::optional<std::string>
read_form_body (JSContext* ctx, JSValueConst value, BodyMode mode, Body& out) {
    const char* member = mode == BodyMode::Form ? "urlencoded" : "formdata";
    const std::string where = std::string ("pm.sendRequest options.body.") + member;

    ScopedValue list (ctx, JS_GetPropertyStr (ctx, value, member));
    if (JS_IsUndefined (list.get ()) || JS_IsNull (list.get ())) {
        return where + " is missing - options.body.mode '" + member + "' reads its rows from there";
    }
    if (auto reason = read_form_fields (ctx, list.get (), where, out.fields)) {
        return reason;
    }
    out.mode = mode;
    return std::nullopt;
}

// pm.sendRequest's body: a raw string, or Postman's `{ mode, <mode>: ... }` for
// the modes `raw`, `urlencoded` and `formdata`.
//
// A raw body is read as Text, which the send path sends as `text/plain` unless
// the script's headers name a Content-Type (issue #2464); a named one always
// wins. Every other Postman mode (`file`, `graphql`) is refused by name rather
// than sent as an empty body: a request that goes out without the payload the
// script wrote is worse than one that does not go out.
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
               "{ mode: 'raw' | 'urlencoded' | 'formdata', ... }, got " +
        std::string (js_type_name (ctx, value));
    }

    ScopedValue mode (ctx, JS_GetPropertyStr (ctx, value, "mode"));
    const std::string mode_text =
    JS_IsString (mode.get ()) ? js_to_string (ctx, mode.get ()) : "";
    if (mode_text == "urlencoded") {
        return read_form_body (ctx, value, BodyMode::Form, out);
    }
    if (mode_text == "formdata") {
        return read_form_body (ctx, value, BodyMode::FormData, out);
    }
    if (mode_text != "raw") {
        return "pm.sendRequest supports options.body.mode 'raw', 'urlencoded' "
               "and 'formdata' (got " +
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

// One auth block's parameters, by name.
using AuthParameters = std::map<std::string, std::string>;

// Postman writes an auth block in two shapes and a script may hand over either:
// `[{ key, value }]` as an exported collection carries it, or `{ name: value }`
// as a script hand-writes it. Both are read, for the same reason the header
// option reads both spellings - a parameter silently vanishing is a request
// sent with the wrong credential.
std::optional<std::string> read_auth_parameters (JSContext* ctx,
JSValueConst block,
const std::string& type,
AuthParameters& out) {
    const std::string where = "pm.sendRequest options.auth." + type;
    if (JS_IsUndefined (block) || JS_IsNull (block)) {
        return std::nullopt;
    }
    // A scalar the block's own value: `{ type: 'bearer', bearer: 'tok' }` is
    // not a shape Postman writes, and reading it as a token would guess which
    // parameter was meant.
    if (!JS_IsObject (block) || JS_IsFunction (ctx, block)) {
        return where + " must be an object or an array of { key, value } entries, got " +
        std::string (js_type_name (ctx, block));
    }

    const auto read_value = [&] (JSValueConst value, const std::string& name,
                            std::optional<std::string>& reason) -> std::optional<std::string> {
        if (JS_IsUndefined (value) || JS_IsNull (value)) {
            return std::nullopt;
        }
        if (!JS_IsString (value) && !JS_IsNumber (value) && !JS_IsBool (value)) {
            reason = where + "." + name + " must be a string, got " +
            std::string (js_type_name (ctx, value));
            return std::nullopt;
        }
        return js_to_string (ctx, value);
    };

    std::optional<std::string> reason;
    if (JS_IsArray (block)) {
        int64_t length = 0;
        if (JS_GetLength (ctx, block, &length) < 0) {
            return where + " could not be enumerated";
        }
        for (int64_t i = 0; i < length; i++) {
            ScopedValue entry (ctx, JS_GetPropertyInt64 (ctx, block, i));
            if (!JS_IsObject (entry.get ()) || JS_IsArray (entry.get ())) {
                return where + " entries must be { key, value } objects, got " +
                std::string (js_type_name (ctx, entry.get ()));
            }
            ScopedValue key (ctx, JS_GetPropertyStr (ctx, entry.get (), "key"));
            if (!JS_IsString (key.get ())) {
                return where + " entries need a string 'key', got " +
                std::string (js_type_name (ctx, key.get ()));
            }
            const std::string name = js_to_string (ctx, key.get ());
            ScopedValue value (ctx, JS_GetPropertyStr (ctx, entry.get (), "value"));
            if (auto text = read_value (value.get (), name, reason)) {
                out[name] = std::move (*text);
            }
            if (reason) {
                return reason;
            }
        }
        return std::nullopt;
    }

    for (const char* name : { "token", "username", "password", "key", "value", "in" }) {
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, block, name));
        if (auto text = read_value (value.get (), name, reason)) {
            out[name] = std::move (*text);
        }
        if (reason) {
            return reason;
        }
    }
    return std::nullopt;
}

// pm.sendRequest's `auth`, in Postman's own shape: `{ type, <type>: params }`.
//
// The three types the engine can compose become its typed `Auth`, applied by
// `vayu::http::apply_auth` - the same function every other send here composes
// credentials with, because a second copy of "Basic " + base64 in the script
// layer would not receive that one's fixes. Every other type is refused by
// name: dropping the option sends an unauthenticated request that looks like
// the script's own mistake, which is the silent wrong request the body modes
// are refused to prevent.
std::optional<std::string>
read_send_request_auth (JSContext* ctx, JSValueConst value, vayu::http::Auth& out) {
    if (JS_IsUndefined (value) || JS_IsNull (value)) {
        return std::nullopt;
    }
    if (!JS_IsObject (value) || JS_IsArray (value) || JS_IsFunction (ctx, value)) {
        return "pm.sendRequest options.auth must be an object like "
               "{ type: 'bearer', bearer: { token: '...' } }, got " +
        std::string (js_type_name (ctx, value));
    }

    ScopedValue js_type (ctx, JS_GetPropertyStr (ctx, value, "type"));
    if (!JS_IsString (js_type.get ())) {
        return "pm.sendRequest options.auth needs a string 'type' (basic, "
               "bearer, apikey or noauth), got " +
        std::string (js_type_name (ctx, js_type.get ()));
    }

    const std::string type = js_to_string (ctx, js_type.get ());
    if (type == "noauth" || type == "none") {
        out = vayu::http::NoAuth{};
        return std::nullopt;
    }
    if (type != "basic" && type != "bearer" && type != "apikey") {
        // oauth2 included, and deliberately: acquiring a token needs the
        // database this path does not have, so composing it here would either
        // reach for state the sandbox has no business holding or send the
        // request with no token at all.
        return "pm.sendRequest options.auth type \"" + type +
        "\" is not supported - the sandbox composes basic, bearer and apikey. "
        "Build the credential yourself and set the header; the request is "
        "refused rather than sent unauthenticated.";
    }

    AuthParameters params;
    ScopedValue block (ctx, JS_GetPropertyStr (ctx, value, type.c_str ()));
    if (JS_IsUndefined (block.get ()) || JS_IsNull (block.get ())) {
        // A type naming a block that is not there - `{ type: 'basic' }`, or the
        // key misspelled - is refused rather than read as an empty credential.
        // Basic is why this is checked here rather than left to the per-type
        // reads below: neither of its halves is required, so an absent block
        // would compose `Basic Og==` and send it, which is the silent wrong
        // request in the one shape the required-field checks cannot see.
        return "pm.sendRequest options.auth names type \"" + type +
        "\" but carries no options.auth." + type + " block to read it from";
    }
    if (auto reason = read_auth_parameters (ctx, block.get (), type, params)) {
        return reason;
    }
    const auto parameter = [&params] (const std::string& name) {
        const auto it = params.find (name);
        return it == params.end () ? std::string () : it->second;
    };

    if (type == "bearer") {
        std::string token = parameter ("token");
        if (token.empty ()) {
            return std::string ("pm.sendRequest options.auth.bearer needs a "
                                "'token' - an empty one would send the header "
                                "with nothing after \"Bearer\"");
        }
        out = vayu::http::BearerAuth{ std::move (token) };
        return std::nullopt;
    }
    if (type == "basic") {
        // Neither half is required: Postman sends an empty username or password
        // as the empty string, and the pair is base64-encoded either way.
        out = vayu::http::BasicAuth{ parameter ("username"), parameter ("password") };
        return std::nullopt;
    }

    const std::string in = parameter ("in");
    if (!in.empty () && in != "header" && in != "query") {
        return "pm.sendRequest options.auth.apikey.in must be 'header' or "
               "'query' (got \"" +
        in + "\")";
    }
    std::string key = parameter ("key");
    if (key.empty ()) {
        return std::string (
        "pm.sendRequest options.auth.apikey needs a 'key' - "
        "the header name, or query parameter name, the "
        "value is sent under");
    }
    out = vayu::http::ApiKeyAuth{ std::move (key), parameter ("value"), in == "query" };
    return std::nullopt;
}

// One string pm.sendRequest was handed, resolved against the scopes the script
// can see. @p what names the field a refusal is about.
std::optional<std::string>
resolve_send_request_text (JSContext* ctx, std::string& text, const std::string& what) {
    std::string missing;
    auto resolved = resolve_script_template (ctx, text, missing);
    if (!resolved) {
        return missing_column_message (ctx, "pm.sendRequest " + what, missing);
    }
    text = std::move (*resolved);
    return std::nullopt;
}

/**
 * Every header of the call, name and value both resolved, into lines rebuilt
 * rather than edited in place - a resolved name is a different name.
 *
 * The collision that rebuild can produce is `http/header_names.hpp`'s, refused
 * in its words rather than in words of this layer's own: composition and the
 * residual pass both answer a resolved name landing on a name the request
 * already carries by refusing the send, and a third answer invented here is how
 * the three would drift. The options are read single-valued, so two names the
 * script wrote itself are one line by the time this reads them, and every
 * collision left is one resolution produced - `{{h}}` resolving to
 * `authorization` beside an `Authorization` the script wrote.
 *
 * Nothing is written back until every name is in, so a refused call leaves the
 * request as the script wrote it rather than half rebuilt.
 */
std::optional<std::string> resolve_send_request_headers (JSContext* ctx, HeaderList& headers) {
    HeaderList resolved;
    // Kept beside `resolved` so a refusal can name both spellings.
    vayu::http::HeaderNameOrigins produced;
    for (const auto& [name, value] : headers) {
        std::string resolved_name = name;
        if (auto reason = resolve_send_request_text (
            ctx, resolved_name, "header name '" + name + "'")) {
            return reason;
        }
        resolved_name =
        std::string (vayu::http::trim_optional_whitespace (resolved_name));
        if (resolved_name.empty ()) {
            // A name written empty is refused as the headers are read; one
            // *resolved* empty reaches nothing that would notice - the pre-send
            // gate reads header text for the bytes that break a line, and
            // libcurl writes what is left as `": value"` and sends it. Since
            // #1084 composition and the residual pass refuse it too, so the
            // wording is `http/header_names.hpp`'s rather than this layer's -
            // the same move the collision beside it already made.
            return "pm.sendRequest: " + vayu::http::describe_empty_header_name (name);
        }
        if (auto invalid = vayu::http::invalid_header_name_refusal (resolved_name)) {
            return "pm.sendRequest: " + *invalid;
        }
        // Padding is not a spelling: ` X-A` beside `X-A` is a repeat as typed.
        if (auto collision = vayu::http::record_produced_name (produced, resolved_name,
            std::string (vayu::http::trim_optional_whitespace (name)))) {
            return "pm.sendRequest: " +
            vayu::http::describe_header_name_collision (*collision);
        }
        std::string resolved_value = value;
        if (auto reason = resolve_send_request_text (
            ctx, resolved_value, "header '" + name + "'")) {
            return reason;
        }
        resolved.add (std::move (resolved_name), std::move (resolved_value));
    }
    headers = std::move (resolved);
    return std::nullopt;
}

// A form body's rows, name and value both resolved, as a header's are.
std::optional<std::string>
resolve_send_request_fields (JSContext* ctx, std::vector<FormField>& fields) {
    for (auto& field : fields) {
        const std::string written = field.key;
        if (auto reason = resolve_send_request_text (
            ctx, field.key, "form field name '" + written + "'")) {
            return reason;
        }
        if (auto reason = resolve_send_request_text (
            ctx, field.value, "form field '" + written + "'")) {
            return reason;
        }
    }
    return std::nullopt;
}

// Every string pm.sendRequest was handed, resolved once against the scopes the
// script can see: the URL, each header name and value, a raw body, a form
// body's field names and values, and each credential of an auth block. Postman
// resolves these, and until #1001 Vayu
// sent them as written - so `pm.sendRequest("{{baseUrl}}/token", cb)` was a
// wrong request sent silently rather than a refusal. Resolving here rather than
// at parse time is what gives it Postman's mid-script visibility: a value the
// same script set two lines earlier is in the scopes this reads.
//
// Header names were the half #1001 left written as they stood, because the
// collision two resolved names can make was undecided; #1051 decided it, so
// #1067 resolves them under that rule - see `resolve_send_request_headers`.
std::optional<std::string>
interpolate_send_request (JSContext* ctx, Request& request, vayu::http::Auth& auth) {
    if (auto reason = resolve_send_request_text (ctx, request.url, "options.url")) {
        return reason;
    }
    if (auto reason = resolve_send_request_headers (ctx, request.headers)) {
        return reason;
    }
    if (request.body.mode == BodyMode::Text) {
        if (auto reason = resolve_send_request_text (ctx, request.body.content, "options.body")) {
            return reason;
        }
    }
    if (vayu::http::is_form_mode (request.body.mode)) {
        if (auto reason = resolve_send_request_fields (ctx, request.body.fields)) {
            return reason;
        }
    }

    // Driven by the walk `apply_auth` shares, so a credential cannot be
    // resolved in one place and applied from another.
    std::optional<std::string> failure;
    vayu::http::walk_auth_credentials (
    auth, [&] (std::string& credential, vayu::http::CredentialDestination) {
        if (failure) {
            return;
        }
        failure = resolve_send_request_text (ctx, credential, "options.auth");
    });
    return failure;
}

// Translate pm.sendRequest's first argument into a Request.
// @return why it was rejected, or nullopt when `out` is filled.
std::optional<std::string>
build_send_request (JSContext* ctx, JSValueConst arg, Request& out, vayu::http::Auth& auth) {
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
        method_text = vayu::utils::ascii_upper (method_text);
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
        // Single-valued, as `pm.request.headers` is: a repeated key is the
        // last one, the rule this option has always had.
        Headers headers;
        if (auto reason = read_send_request_headers (ctx, chosen, headers)) {
            return reason;
        }
        out.headers = HeaderList (headers);
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

    ScopedValue js_auth (ctx, JS_GetPropertyStr (ctx, arg, "auth"));
    return read_send_request_auth (ctx, js_auth.get (), auth);
}

// The response a pm.sendRequest callback receives.
//
// A deliberate subset of pm.response: code, status, responseTime, headers,
// json() and text(). `status` is the reason phrase, as it is on pm.response -
// which is Postman's contract and, since the two spellings moved together in
// #1000, still leaves no room for two objects called a response inside one
// sandbox to disagree about what `status` means. The phrase comes from the
// same `response_reason_phrase` pm.response and `to.have.status` read, and
// the body readers are the same two functions pm.response installs, so
// neither answer can drift from its sibling.
JSValue build_send_response (JSContext* ctx, const Response& response) {
    JSValue result = JS_NewObject (ctx);

    JS_SetPropertyStr (ctx, result, "code", JS_NewInt32 (ctx, response.status_code));
    JS_SetPropertyStr (ctx, result, "status",
    JS_NewString (ctx, response_reason_phrase (response).c_str ()));
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

// The promise form's answer: a promise already settled with what the
// callback form passes, rejected with @p err when it is not null and resolved
// with @p res otherwise. Takes ownership of both.
JSValue settled_send_promise (JSContext* ctx, JSValue err, JSValue res) {
    ScopedValue owned_err (ctx, err);
    ScopedValue owned_res (ctx, res);
    std::array<JSValue, 2> settle{ JS_UNDEFINED, JS_UNDEFINED };
    JSValue promise = JS_NewPromiseCapability (ctx, settle.data ());
    if (JS_IsException (promise)) {
        return promise;
    }
    ScopedValue resolve (ctx, settle[0]);
    ScopedValue reject (ctx, settle[1]);
    const bool failed = !JS_IsNull (err);
    JSValue outcome   = failed ? err : res;
    JSValue settled =
    JS_Call (ctx, failed ? reject.get () : resolve.get (), JS_UNDEFINED, 1, &outcome);
    if (JS_IsException (settled)) {
        JS_FreeValue (ctx, promise);
        return settled;
    }
    JS_FreeValue (ctx, settled);
    return promise;
}

} // namespace

/**
 * pm.sendRequest(urlOrOptions, callback?)
 *
 * Synchronous by construction in both of Postman's forms: the send blocks,
 * then callback(err, res) runs inline, or, called without a callback, a
 * promise comes back already settled - rejected with `err`, or resolved with
 * `res` (#2577). Nothing is left in flight, so `await pm.sendRequest(...)` has
 * the answer by the next promise job.
 *
 * Four things are refused by throwing rather than by calling the callback or
 * rejecting, because they are the script's mistakes and not the network's: the
 * feature being off, the per-script request cap, an unusable argument, and a
 * URL naming Vayu's own engine or MCP port (`http/loopback_guard.hpp`).
 * Transport failures - refused, DNS, timeout - are the network's answer and
 * reach the callback as an error, which is where a Postman script looks for
 * them.
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

    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "pm.sendRequest requires a URL (or options object)");
    }
    const bool promise_form = argc < 2 || JS_IsUndefined (argv[1]);
    if (!promise_form && !JS_IsFunction (ctx, argv[1])) {
        return JS_ThrowTypeError (ctx,
        "pm.sendRequest's second argument must be a callback function; "
        "leave it out to get a promise of the response instead");
    }

    constexpr int limit = vayu::core::constants::script_engine::SEND_REQUEST_LIMIT;
    if (data->send_request_count >= limit) {
        return JS_ThrowPlainError (ctx,
        "pm.sendRequest may issue at most %d requests per script; this is "
        "request %d",
        limit, data->send_request_count + 1);
    }

    Request request;
    vayu::http::Auth auth = vayu::http::NoAuth{};
    if (auto reason = build_send_request (ctx, argv[0], request, auth)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }
    if (auto reason = interpolate_send_request (ctx, request, auth)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }
    // Postman builds this call's Item with `protocolProfileBehavior` of its
    // own (`disableBodyPruning` alone, `event.command.js`) and no parent, so
    // neither the enclosing request's `disableUrlEncoding` nor anything the
    // script passes turns this off.
    //
    // `wire_url` writes the same line again (the encoder is idempotent); it
    // is written here too so the reserved-port check below reads the host the
    // transfer will dial, leading whitespace dropped and lowercased (#2465).
    request.url = vayu::core::encode_url_as_postman (request.url);
    // The engine's own composition rather than a second copy of it: a header
    // the script set still wins, and an api key sent as a query parameter is
    // percent-encoded onto the URL exactly as every other send does it. `db` is
    // null because the three types this path accepts need none - oauth2, the
    // one that would, is refused by name while the options are read.
    if (const auto applied = vayu::http::apply_auth (request, auth, nullptr);
    !applied.ok) {
        return JS_ThrowPlainError (ctx,
        "pm.sendRequest could not apply options.auth: %s", applied.message.c_str ());
    }
    // The transport refuses this too, but as a network error in the callback;
    // a script that names Vayu's own port gets a sentence about scripts
    // (#2355).
    if (const auto port = vayu::http::reserved_target_port (request.url)) {
        return JS_ThrowPlainError (ctx,
        "pm.sendRequest refused: %s. A script may call any other server on "
        "this machine.",
        vayu::http::reserved_target_refusal (*port).c_str ());
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
    if (auto host = vayu::http::cookie_scope_host (request.url)) {
        data->addressed_hosts.push_back (std::move (*host));
    }

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
    client_config.transport       = data->transport;
    client_config.default_headers = data->default_headers;
    // The bound the enclosing execution resolved for its own read (issue
    // #1188), so a script's fetch is not the one read with no byte bound left.
    // `truncate_over_limit` stays false: a script parses what it is handed, and
    // there is no property on this response object that could tell it the body
    // was cut - so the honest answer to an oversized body is the error the
    // callback can catch, not a prefix.
    client_config.max_response_bytes = data->max_response_bytes;
    // Ends with the enclosing exchange's own send (issue #2683).
    client_config.cancel = data->cancel;
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
    if (promise_form) {
        return settled_send_promise (ctx, err, res);
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

} // namespace vayu::runtime::pm_detail
