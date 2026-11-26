/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `pm.sendRequest`, and the auth block reader it shares with `pm.request.auth`
 * (`pm_auth.hpp`).
 */

#include "pm_auth.hpp"
#include "pm_internal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <limits>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/url_encoding.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/send_log.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::runtime::pm_detail {

// ============================================================================
// Postman's auth block - pm.sendRequest's options.auth and pm.request.auth
// ============================================================================

namespace {

// One auth block's parameters, by name.
using AuthParameters = std::map<std::string, std::string>;

/// The parameter names one composable auth type takes, as Postman names them.
struct AuthTypeParameters {
    std::string_view type;
    /// Read into the credential.
    std::span<const std::string_view> accepted;
    /// Written by Postman's own auth helper beside the credential and read by
    /// nothing that sends: skipped, so an exported block still reads.
    std::span<const std::string_view> ignored;
};

constexpr auto BASIC_PARAMETERS =
std::to_array<std::string_view> ({ "username", "password" });
constexpr auto BASIC_HELPER_STATE =
std::to_array<std::string_view> ({ "showPassword" });
constexpr auto BEARER_PARAMETERS =
std::to_array<std::string_view> ({ "token" });
constexpr auto API_KEY_PARAMETERS =
std::to_array<std::string_view> ({ "key", "value", "in" });
constexpr auto COMPOSABLE_AUTH_TYPES = std::to_array<AuthTypeParameters> ({
{ "basic", BASIC_PARAMETERS, BASIC_HELPER_STATE },
{ "bearer", BEARER_PARAMETERS, {} },
{ "apikey", API_KEY_PARAMETERS, {} },
});

const AuthTypeParameters* composable_auth_type (std::string_view type) {
    const auto found =
    std::find_if (COMPOSABLE_AUTH_TYPES.begin (), COMPOSABLE_AUTH_TYPES.end (),
    [type] (const AuthTypeParameters& named) { return named.type == type; });
    return found == COMPOSABLE_AUTH_TYPES.end () ? nullptr : &*found;
}

bool names_one_of (std::span<const std::string_view> names, std::string_view name) {
    return std::find (names.begin (), names.end (), name) != names.end ();
}

/// `username, password`, for a refusal that has to say what would have read.
std::string listed (std::span<const std::string_view> names) {
    std::string out;
    for (const std::string_view name : names) {
        out += (out.empty () ? "" : ", ") + std::string (name);
    }
    return out;
}

/**
 * One parameter of @p spec's block into @p out, by its name. A name the type
 * does not take is refused listing the ones it does: read past, a misspelled
 * `user` would leave `username` empty and send the credential without it.
 */
std::optional<std::string> read_auth_parameter (JSContext* ctx,
const AuthTypeParameters& spec,
const std::string& where,
const std::string& name,
JSValueConst value,
AuthParameters& out) {
    if (names_one_of (spec.ignored, name)) {
        return std::nullopt;
    }
    if (!names_one_of (spec.accepted, name)) {
        return where + " has no parameter '" + name + "' - " +
        std::string (spec.type) + " takes " + listed (spec.accepted);
    }
    if (JS_IsUndefined (value) || JS_IsNull (value)) {
        return std::nullopt;
    }
    if (!JS_IsString (value) && !JS_IsNumber (value) && !JS_IsBool (value)) {
        return where + "." + name + " must be a string, got " +
        std::string (js_type_name (ctx, value));
    }
    out[name] = js_to_string (ctx, value);
    return std::nullopt;
}

/// `[{ key, value }]`, an exported collection's spelling. An entry's other
/// members (Postman writes `type: 'string'`) describe the entry, not the
/// credential. A repeated key reads as its last entry, as an import reads it.
std::optional<std::string> read_auth_entries (JSContext* ctx,
JSValueConst block,
const AuthTypeParameters& spec,
const std::string& where,
AuthParameters& out) {
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
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, entry.get (), "value"));
        if (auto reason = read_auth_parameter (ctx, spec, where,
            js_to_string (ctx, key.get ()), value.get (), out)) {
            return reason;
        }
    }
    return std::nullopt;
}

/// `{ name: value }`, a hand-written block's spelling.
std::optional<std::string> read_auth_members (JSContext* ctx,
JSValueConst block,
const AuthTypeParameters& spec,
const std::string& where,
AuthParameters& out) {
    std::vector<std::string> names;
    if (!js_own_enumerable_keys (ctx, block, names)) {
        return where + " could not be enumerated";
    }
    for (const auto& name : names) {
        ScopedValue value (ctx, JS_GetPropertyStr (ctx, block, name.c_str ()));
        if (auto reason = read_auth_parameter (ctx, spec, where, name, value.get (), out)) {
            return reason;
        }
    }
    return std::nullopt;
}

// Postman writes an auth block two ways and a script may hand over either:
// `[{ key, value }]` as an exported collection carries it, `{ name: value }` as
// a script hand-writes it. Both are read, as both header spellings are: a
// parameter silently vanishing sends the wrong credential.
std::optional<std::string> read_auth_parameters (JSContext* ctx,
JSValueConst block,
const AuthTypeParameters& spec,
const std::string& where,
AuthParameters& out) {
    // A scalar is no block: `{ type: 'bearer', bearer: 'tok' }` is no shape
    // Postman writes, and reading it as a token would guess the parameter.
    if (!JS_IsObject (block) || JS_IsFunction (ctx, block)) {
        return where + " must be an object or an array of { key, value } entries, got " +
        std::string (js_type_name (ctx, block));
    }
    return JS_IsArray (block) ? read_auth_entries (ctx, block, spec, where, out) :
                                read_auth_members (ctx, block, spec, where, out);
}

// An api key's parameters, refused where the header or query parameter it
// names could not be written.
std::optional<std::string> read_api_key (const AuthParameters& params,
const std::string& where,
vayu::http::Auth& out) {
    const auto parameter = [&params] (const std::string& name) {
        const auto it = params.find (name);
        return it == params.end () ? std::string () : it->second;
    };
    const std::string in = parameter ("in");
    if (!in.empty () && in != "header" && in != "query") {
        return where + ".in must be 'header' or 'query' (got \"" + in + "\")";
    }
    std::string key = parameter ("key");
    if (key.empty ()) {
        return where +
        " needs a 'key' - the header name, or query parameter name, "
        "the value is sent under";
    }
    out = vayu::http::ApiKeyAuth{ std::move (key), parameter ("value"), in == "query" };
    return std::nullopt;
}

} // namespace

// The three types the engine can compose become its typed `Auth`, applied by
// `vayu::http::apply_auth`, as for every other send here: a second "Basic " +
// base64 in the script layer would miss its fixes. Every other type is refused
// by name: dropping the block sends an unauthenticated request that looks like
// the script's own mistake, the silent wrong request the body modes are refused
// to prevent.
std::optional<std::string> read_script_auth (JSContext* ctx,
JSValueConst value,
const ScriptAuthSlot& slot,
vayu::http::Auth& out) {
    if (JS_IsUndefined (value) || JS_IsNull (value)) {
        return std::nullopt;
    }
    const std::string label (slot.label);
    if (!JS_IsObject (value) || JS_IsArray (value) || JS_IsFunction (ctx, value)) {
        return label +
        " must be an object like "
        "{ type: 'bearer', bearer: { token: '...' } }, got " +
        std::string (js_type_name (ctx, value));
    }

    ScopedValue js_type (ctx, JS_GetPropertyStr (ctx, value, "type"));
    if (!JS_IsString (js_type.get ())) {
        return label + " needs a string 'type' (basic, bearer, apikey or noauth), got " +
        std::string (js_type_name (ctx, js_type.get ()));
    }

    const std::string type = js_to_string (ctx, js_type.get ());
    if (type == "noauth" || type == "none") {
        out = vayu::http::NoAuth{};
        return std::nullopt;
    }
    const AuthTypeParameters* spec = composable_auth_type (type);
    if (spec == nullptr) {
        // oauth2 included, deliberately: acquiring a token needs the database
        // this path lacks, so composing it would reach for state the sandbox
        // has no business holding, or send no token at all.
        return label + " type \"" + type +
        "\" is not supported - the sandbox composes basic, bearer and apikey. "
        "Build the credential yourself and set the header.";
    }

    ScopedValue block (ctx, JS_GetPropertyStr (ctx, value, type.c_str ()));
    if (JS_IsUndefined (block.get ()) || JS_IsNull (block.get ())) {
        // A type naming an absent block (`{ type: 'basic' }`, or a misspelled
        // key) is refused naming the block, which says more than the missing
        // credential the per-type reads would report.
        return label + " names type \"" + type + "\" but carries no " +
        std::string (slot.path) + "." + type + " block to read it from";
    }
    const std::string where = label + "." + type;
    AuthParameters params;
    if (auto reason = read_auth_parameters (ctx, block.get (), *spec, where, params)) {
        return reason;
    }

    if (type == "apikey") {
        return read_api_key (params, where, out);
    }
    if (type == "bearer") {
        auto token = params.find ("token");
        if (token == params.end () || token->second.empty ()) {
            return where +
            " needs a 'token' - an empty one would send no "
            "Authorization header at all";
        }
        out = vayu::http::BearerAuth{ std::move (token->second) };
        return std::nullopt;
    }
    // Basic: either half may be empty (Postman sends ""), not both:
    // `Basic Og==` carries no credential.
    std::string username = params["username"];
    std::string password = params["password"];
    if (username.empty () && password.empty ()) {
        return where +
        " needs a 'username' or a 'password' - with neither, the header "
        "would carry an empty credential";
    }
    out = vayu::http::BasicAuth{ std::move (username), std::move (password) };
    return std::nullopt;
}

std::optional<std::string>
resolve_script_auth (JSContext* ctx, vayu::http::Auth& auth, std::string_view label) {
    std::optional<std::string> failure;
    vayu::http::walk_auth_credentials (
    auth, [&] (std::string& credential, vayu::http::CredentialDestination) {
        if (failure) {
            return;
        }
        std::string missing;
        auto resolved = resolve_script_template (ctx, credential, missing);
        if (!resolved) {
            failure = missing_column_message (ctx, std::string (label), missing);
            return;
        }
        credential = std::move (*resolved);
    });
    return failure;
}

namespace {

constexpr ScriptAuthSlot SEND_REQUEST_AUTH{ "pm.sendRequest options.auth", "options.auth" };

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

// pm.sendRequest's headers in either Postman shape: an array of
// `{ key, value }`, what a Postman script carries over, or a plain object, what
// `pm.request.headers` reads as here, so a header copied between them does not
// vanish.
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
// form. A file part (`type: 'file'`, a `src` and no value) is refused by name:
// the sandbox has no grant to read a file with, and the part sent without its
// file is the silent wrong request.
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

// A form body's rows in either Postman shape, an array of
// `{ key, value, disabled? }` (exported) or a `{ name: value }` object
// (hand-written), for the headers' reason: a vanishing row sends a request
// short. A disabled row is validated, then left out, what disabled means on the
// wire (`enabled_fields`).
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

// `{ mode: 'urlencoded', urlencoded: [...] }` or the `formdata` pair: the rows
// become the body's fields and the send path's encoders do the rest
// (`encode_urlencoded`, libcurl's multipart), with the Content-Type they imply
// unless the script names one. Serialising here would copy the encoders and
// miss the multipart boundary.
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
// `raw`, `urlencoded` and `formdata`. A raw body is Text, sent as `text/plain`
// unless the script names a Content-Type (#2464), which always wins. Other
// Postman modes (`file`, `graphql`) are refused by name, not sent empty: a
// request without the payload the script wrote is worse than none.
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
 * Every header of the call, name and value resolved, into rebuilt lines (a
 * resolved name is a different name). The collision a rebuild can produce is
 * `http/header_names.hpp`'s, refused in its words: composition and the residual
 * pass both refuse a resolved name landing on one the request carries, and a
 * third answer here is how the three would drift. The options are read
 * single-valued, so two names the script wrote are one line already, and every
 * collision left is one resolution produced (`{{h}}` resolving to
 * `authorization` beside a written `Authorization`). Nothing is written back
 * until every name is in, so a refused call leaves the request as written.
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
            // A name written empty is refused as headers are read; one resolved
            // empty reaches nothing that notices (the pre-send gate reads
            // header text for line-breaking bytes, and libcurl sends
            // `": value"`). Composition and the residual pass refuse it too
            // (#1084), so the wording is `http/header_names.hpp`'s, as for the
            // collision beside it.
            return "pm.sendRequest: " + vayu::http::describe_empty_header_name (name);
        }
        if (auto invalid = vayu::http::invalid_header_name_refusal (
            resolved_name, vayu::http::trim_optional_whitespace (name))) {
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
// body's names and values, each credential of an auth block. Postman resolves
// these (#1001), so `pm.sendRequest("{{baseUrl}}/token", cb)` is no silently
// wrong request. Resolving here, not at parse time, gives Postman's mid-script
// visibility: a value set two lines earlier is in the scopes. Header names
// resolve under `http/header_names.hpp`'s collision rule (#1051, #1067;
// `resolve_send_request_headers`).
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

    return resolve_script_auth (ctx, auth, SEND_REQUEST_AUTH.label);
}

// pm.sendRequest's first argument as a Request.
// @return why it was rejected, or nullopt when `out` is filled.
std::optional<std::string>
build_send_request (JSContext* ctx, JSValueConst arg, Request& out, vayu::http::Auth& auth) {
    // A Url object is `pm.sendRequest(pm.request.url, cb)`, the natural "send
    // this again" (#991), read before the options-object branch, which would
    // refuse it for having no `url` member.
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
        // Postman's literal URL-object form (a hand-built
        // `{host: [...], path: [...]}`) is not accepted; pm.request.url is.
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
        // pm.request's write-back normalisation: 'post' means POST, while an
        // unrecognised verb still fails loudly.
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

    // `header` is Postman's spelling, `headers` pm.request's; both are read,
    // neither preferred: given both, which the script meant is unknowable, and
    // dropping either would send a request missing headers it wrote.
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
        // last.
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
    return read_script_auth (ctx, js_auth.get (), SEND_REQUEST_AUTH, auth);
}

// The response a pm.sendRequest callback receives, a deliberate subset of
// pm.response: code, status, responseTime, headers, json() and text(). `status`
// is the reason phrase, as on pm.response (Postman's contract; #1000), so two
// objects called a response in one sandbox agree on it. The phrase is
// `response_reason_phrase`'s, read by pm.response and `to.have.status` too, and
// the body readers are pm.response's two functions, so neither can drift from
// its sibling.
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

// The exchange as the record a trace stores (#3633): `build_result_trace`'s
// node, masked where built, so every reader of the stored trace reads it
// masked. `rawRequest` is left out (it repeats the header block as text the
// mask does not parse; a reader synthesizes it); a urlencoded body is held as
// fields the trace does not write, so the record adds the bytes sent.
nlohmann::json send_record (const Request& request, const Response& response, int64_t started_at_ms) {
    nlohmann::json record = vayu::http::routes::build_result_trace (request, response);
    auto& sent_request = record["request"];
    sent_request.erase ("rawRequest");
    if (!sent_request.contains ("body")) {
        if (auto bytes = vayu::http::wire_body_bytes (request); !bytes.empty ()) {
            sent_request["body"] = std::move (bytes);
        }
    }
    record["startedAt"]  = started_at_ms;
    record["status"]     = response.status_code;
    record["statusText"] = response.status_text;
    vayu::core::vayu_ext::mask_script_request_record (
    record, request.secret_header_names, request.auth_query_param);
    return record;
}

// Records the exchange when the caller asked
// (`ScriptConfig::record_send_requests`) and answers its index. Independent of
// the console: a record is trace, not output. `Client::send` reports a
// transport failure on a status-0 `Response`; an `Error` it might answer
// instead is recorded alike.
std::optional<std::size_t> record_send_exchange (ContextData& data,
const Request& request,
const Result<Response>& sent,
int64_t started_at_ms) {
    if (!data.record_send_requests) {
        return std::nullopt;
    }
    const std::size_t index = data.script_requests.size ();
    if (sent.is_error ()) {
        Response failed;
        failed.error_code    = sent.error ().code;
        failed.error_message = sent.error ().message;
        data.script_requests.push_back (send_record (request, failed, started_at_ms));
    } else {
        data.script_requests.push_back (send_record (request, sent.value (), started_at_ms));
    }
    return index;
}

// The one Console line a script-issued request leaves, so the Console lists
// what a script sent; without it a failed token fetch is invisible (#3462).
// Info level whatever the outcome (the callback decides whether a failure
// matters), written before the callback so its own lines follow. A kept line
// carries @p record, the call's record index, so a reader draws both as one
// row; a line the console cap dropped links nothing.
//
// @p script_url is the URL as given, before auth composes (an api key
// `apply_auth` appends is not the script's text), through an export's
// credential blanking (userinfo password and secret-named query values, as
// `<redacted>`), keeping the rest of the query, which says which call it was.
// Nothing is built with the console off (`scriptEnableConsole`, advised off for
// a load test).
void log_send_request (ContextData& data,
HttpMethod method,
const std::string& script_url,
const Result<Response>& sent,
std::chrono::milliseconds elapsed,
std::optional<std::size_t> record) {
    if (!data.console_enabled) {
        return;
    }
    const ErrorCode error_code =
    sent.is_error () ? sent.error ().code : sent.value ().error_code;
    int blanked = 0;
    std::string line = "pm.sendRequest " + std::string (vayu::to_string (method)) + " " +
    vayu::core::vayu_ext::redact_url_credentials (
    script_url, {}, blanked, vayu::core::vayu_ext::CredentialMark::Marker);
    if (error_code == ErrorCode::None) {
        line += " -> " + std::to_string (sent.value ().status_code);
    } else {
        line += std::string (" failed: ") + vayu::to_string (error_code);
    }
    line += " (" + std::to_string (elapsed.count ()) + " ms)";
    if (data.add_console_entry (ConsoleLevel::Info, std::move (line))) {
        data.console_output.back ().script_request = record;
    }
}

// One log-file record of how the call ended (#3677): a warning for a failed
// send, else debug. Written whatever `scriptEnableConsole` says, since the file
// is where a failed token fetch is found when a load test turned the console
// off; a cancelled send (the exchange ended) is debug, not a failure. A load
// run (`record_send_requests` off) writes none; no `runId`, which the script
// context does not carry.
void log_send_outcome (HttpMethod method,
const std::string& script_url,
const Result<Response>& sent,
std::chrono::milliseconds elapsed) {
    vayu::http::SendOutcome outcome;
    outcome.subject    = "pm.sendRequest";
    outcome.method     = vayu::to_string (method);
    outcome.url        = script_url;
    outcome.elapsed_ms = static_cast<double> (elapsed.count ());
    if (sent.is_error ()) {
        outcome.error_code    = sent.error ().code;
        outcome.error_message = sent.error ().message;
    } else {
        const Response& response = sent.value ();
        outcome.status_code      = response.status_code;
        outcome.error_code       = response.error_code;
        outcome.error_message    = response.error_message;
    }
    const auto record = vayu::http::describe_send_outcome (outcome);
    if (record.failed) {
        vayu::utils::log_warning ("script", record.msg, record.fields);
        return;
    }
    vayu::utils::log_debug ("script", record.msg, record.fields);
}

} // namespace

/**
 * pm.sendRequest(urlOrOptions, callback?), synchronous in both Postman forms:
 * the send blocks, then callback(err, res) runs inline or, without a callback,
 * a promise returns already settled (rejected with `err` or resolved with
 * `res`, #2577), so `await pm.sendRequest(...)` has the answer by the next
 * promise job. Four things throw rather than reach the callback, being the
 * script's mistakes, not the network's: the feature off, the per-script request
 * cap, an unusable argument, and a URL naming Vayu's own engine or MCP port
 * (`http/loopback_guard.hpp`). Transport failures (refused, DNS, timeout) are
 * the network's answer and reach the callback as an error, where a Postman
 * script looks.
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
        "for them, and the MCP server never does. See "
        "docs/engine/mcp/resources-and-prompts.md.");
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
    // Before the options are read, so a `timeout` option replaces it (#2833).
    request.timeout_ms    = data->request_timeout_ms;
    vayu::http::Auth auth = vayu::http::NoAuth{};
    if (auto reason = build_send_request (ctx, argv[0], request, auth)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }
    if (auto reason = interpolate_send_request (ctx, request, auth)) {
        return JS_ThrowTypeError (ctx, "%s", reason->c_str ());
    }
    // Postman builds this call's Item with its own `protocolProfileBehavior`
    // (`disableBodyPruning` alone, `event.command.js`) and no parent, so
    // neither the enclosing request's `disableUrlEncoding` nor the script turns
    // this off. `wire_url` writes it again (the encoder is idempotent); written
    // here so the reserved-port check reads the host the transfer dials,
    // leading whitespace dropped and lowercased (#2465).
    request.url = vayu::core::encode_url_as_postman (request.url);
    const std::string script_url = request.url;
    // The engine's composition, not a copy: a header the script set still wins,
    // and a query api key is percent-encoded onto the URL as on every send.
    // `db` is null because the three accepted types need none; oauth2, which
    // would, is refused while the options are read.
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

    // The script budget's interrupt handler runs only between bytecode
    // operations, so a blocking C function never yields to it: without this
    // clamp a 5s script could hold its thread for the whole request timeout,
    // many times the user's budget, with no error and no interrupt.
    if (auto remaining = remaining_script_budget_ms (ctx)) {
        if (*remaining <= 0) {
            return JS_ThrowPlainError (ctx,
            "pm.sendRequest was called with none of the script's time budget "
            "left");
        }
        request.timeout_ms = static_cast<int> (
        std::min (static_cast<int64_t> (request.timeout_ms), *remaining));
    }

    // Counted before the send, so a failed request still spends budget, or a
    // loop against a refusing host never reaches the cap.
    data->send_request_count++;
    if (auto host = vayu::http::cookie_scope_host (request.url)) {
        data->addressed_hosts.push_back (std::move (*host));
    }

    // Shares the enclosing execute's jar (`ScriptContext::cookie_jar` says
    // why); a null jar (a load run) leaves the client cookie-less, as it was
    // before the jar existed (#301).
    vayu::http::ClientConfig client_config;
    client_config.cookie_jar   = data->cookie_jar;
    client_config.cookie_scope = data->cookie_scope;
    // The enclosing exchange's own route out (#705): a script authenticating
    // through sendRequest and letting the real request carry the session needs
    // both to reach the network alike.
    client_config.transport       = data->transport;
    client_config.default_headers = data->default_headers;
    // The enclosing execution's resolved bound (#1188), so a script's fetch is
    // no unbounded read. `truncate_over_limit` stays false: a script parses
    // what it gets and nothing on this response could say the body was cut, so
    // an oversized body is the error the callback catches, not a prefix.
    client_config.max_response_bytes = data->max_response_bytes;
    // Ends with the enclosing exchange's own send (issue #2683).
    client_config.cancel = data->cancel;
    // Staged jar writes ride this execution's next transfer, this one, so a
    // script that sets a cookie and then sends carries it. Drained, not copied:
    // this transfer's capture persists them, and reapplying would undo what its
    // response changed.
    if (data->cookie_writes) {
        client_config.cookie_writes = std::move (*data->cookie_writes);
        data->cookie_writes->clear ();
    }
    vayu::http::Client client (client_config);
    const auto started_at = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ());
    const auto started = std::chrono::steady_clock::now ();
    auto sent          = client.send (request);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);
    const auto record = record_send_exchange (*data, request, sent, started_at.count ());
    log_send_request (*data, request.method, script_url, sent, elapsed, record);
    if (data->record_send_requests) {
        log_send_outcome (request.method, script_url, sent, elapsed);
    }

    const auto error_code =
    sent.is_error () ? sent.error ().code : sent.value ().error_code;
    if (error_code == vayu::ErrorCode::Cancelled) {
        data->send_cancelled = true;
    }

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
