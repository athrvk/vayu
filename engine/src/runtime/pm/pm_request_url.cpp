/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** `pm.request`, its `Url` object, `pm.info` and the pre-request write-back. */

#include "pm_auth.hpp"
#include "pm_internal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <expected>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/graphql_body.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::runtime::pm_detail {

// ============================================================================
// pm.request.url - the identity half of Postman's Url object
// ============================================================================

/**
 * What `pm.request.url` is, behind the members a script reads: the `Url` object
 * a lifted Postman script expects (#991), with `url.query.get(...)`,
 * `url.getPath()`, `url.host` and the rest, built in
 * `build_request_url_members`. Here lives the identity, which three surfaces
 * read without the members: the `pm.request` write-back, the jar methods and
 * `pm.sendRequest`, each documented as taking `pm.request.url`.
 *
 * `text` is authoritative and `parts` derived from it. `built` says whether the
 * JS members exist yet: a script never mentioning the URL never pays for the
 * parse, which is why the property is an accessor (`install_request_url`).
 */
struct RequestUrlState {
    std::string text;
    vayu::http::UrlParts parts;
    bool built = false;
    // A member was written, so `parts` is ahead of `text` (#1040). Composition
    // is deferred to the next reader of the whole URL and never happens for a
    // URL nobody edited, which keeps `getQueryString()` byte-exact against the
    // wire and a read-only script's request identical to the one it was handed.
    bool dirty = false;
};

namespace {

/**
 * Brings the URL up to date with what the script did to its members, and
 * answers the whole URL (#1040). `query.add` and the `protocol` / `port` /
 * `hash` setters are methods that update the parts and set `dirty`; `path` and
 * `host` are plain JS arrays mutated in place with no notice, so they are read
 * back here and compared, `apply_pm_request_writeback`'s rule for
 * `pm.request.headers`: the object the script holds is what is sent, read when
 * needed. Comparing rather than assuming leaves `dirty` false for a script that
 * only read the URL, so the request goes out as the exact bytes it arrived as,
 * which `getQueryString()`'s byte-exactness depends on.
 *
 * @return why the members could not be read, or nullopt when @p state is
 *         current. Never throws: three of the four callers want a JS exception
 *         and the fourth a write-back reason, so the message is handed back
 *         rather than raised.
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
                // A number is taken (pushing an id onto a path is the obvious
                // case); an object, array or hole is refused rather than
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

/// The whole URL for a caller with no way to report a bad member: the parts
/// stay as they were and the text is the last composed, the URL the write-back
/// then refuses by name.
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

} // namespace

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

namespace {

/**
 * What `pm.request.body` carries (#1003). `body` is the composed body, the
 * source of the mode and field lists; `text` is the string view
 * (`script_body_view`) the object answers every string context with, and the
 * one thing the write-back reads back. A `.raw` assignment moves `text` only:
 * the write-back applies it by the whole-string assignment's rules, one
 * definition of assigning a body.
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

} // namespace

// No gc_mark, for the reason the Url class gives: the state holds C++ values,
// never a JSValue.
JSClassDef request_body_class = { .class_name = "RequestBody",
    .finalizer                                = request_body_finalizer,
    .gc_mark                                  = nullptr,
    .call                                     = nullptr,
    .exotic                                   = nullptr };

namespace {

/// The state behind a RequestBody object, or nullptr for anything else - a real
/// class test, for the reason `request_url_state` gives.
RequestBodyState* request_body_state (JSValueConst value) {
    return static_cast<RequestBodyState*> (JS_GetOpaque (value, request_body_class_id));
}

} // namespace

/**
 * The text an assertion reads a string-like target as: a JS string, or one of
 * the two objects that replaced one on `pm.request`, the Url (#991) and the
 * RequestBody (#1003). Both are documented as behaving as the string they
 * replaced, and `pm.expect(pm.request.url).to.include(...)` is the idiom in
 * this repo's docs and tests: a verdict silently flipping to failing is the
 * worst thing an assertion can do. Only these three: coercing any object would
 * make `pm.expect({}).to.include('object')` pass.
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

/**
 * The URL a value carries, for the surfaces documented as taking
 * `pm.request.url`: a JS string is itself, a Url object its built string,
 * anything else `nullopt`, which the caller words itself ("pm.sendRequest was
 * given a number" and "jar().set needs a URL" are different sentences). Not
 * "any object, via toString": `pm.request.url = {}` would reach the wire as
 * `[object Object]`, the silent-wrong-request class this program closes.
 */
std::optional<std::string>
script_url_text (JSContext* ctx, JSValueConst value, std::string* out_error) {
    if (JS_IsString (value)) {
        return js_to_string (ctx, value);
    }
    if (auto* state = request_url_state (value)) {
        // A member left unbuildable is reported by name through @p out_error
        // where the caller has one: "pm.request.url.path takes strings, got
        // object at index 2" says more than "this is not a URL", and that
        // caller is the write-back, where every pm.request refusal surfaces.
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

/**
 * The name a binary body's file goes by in a script: its declared `fileName`,
 * else its path's last segment (`declared_file_name`'s rule for a form-data
 * file part), never the path, which is one machine's filesystem and can carry a
 * user name (#411).
 */
std::string body_file_name (const FileRef& file) {
    FormField part;
    part.src       = file.src;
    part.file_name = file.file_name;
    return vayu::http::declared_file_name (part);
}

/**
 * The string `pm.request.body` shows and the yardstick the write-back measures
 * an edit against, one function so the two agree. A content mode is its
 * content; `x-www-form-urlencoded` the exact wire body; `form-data` a rendering
 * of the parts, not the bytes sent: libcurl generates a multipart boundary at
 * transfer time, so no faithful string exists before the send, and `content`
 * alone would give every form body `""`, like no body at all.
 *
 * The form modes take different renderers because only one is reversible: the
 * urlencoded view is the wire body and parses back through `parse_urlencoded`,
 * so it stays a plain `key=value` list, while form-data names its file parts
 * (`key=@filename`), which a pair would lose (#411). A file part is valid only
 * under form-data, so this costs urlencoded nothing. A `binary` body reads as
 * `@<fileName>`, a file part's spelling: the script never sees its bytes, and
 * its path is never disclosed (`body_file_name`).
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

} // namespace

/**
 * Which of the request's header records a script shows. The two differ (#483):
 * `request->headers` is what the request was composed with;
 * `response->request_headers` is what was sent: that map minus headers the
 * transfer suppresses, plus those the engine derives at curl setup (the
 * body-implied `Content-Type`, `application/json` for GraphQL,
 * `application/x-www-form-urlencoded` for a form; the default `User-Agent`). A
 * test asking which Content-Type went out for a GraphQL body asks about the
 * sent record; the composed map cannot answer, as nobody wrote that header.
 *
 * So a **test** script reads the sent record and a **pre-request** script the
 * composed map, a forced split: before the send no sent record exists, and the
 * pre-request object is the one `apply_pm_request_writeback` applies back, so
 * showing it another set would make `delete` act on headers the request never
 * carried.
 *
 * The fallback is load-bearing: a load run's deferred validation rebuilds its
 * `Response` from a sampled response (`run_manager.cpp`) recording no sent
 * headers, and seeding from that empty map would make `pm.request.headers`
 * empty. An empty sent record means nothing was recorded, never that nothing
 * was sent.
 */
const HeaderList& script_request_header_lines (const ContextData& data) {
    if (data.response != nullptr && !data.response->request_headers.empty ()) {
        return data.response->request_headers;
    }
    return data.request->headers;
}

namespace {

// `pm.request.headers` shows that set folded, one value per name
// (`HeaderList::folded`): the scripting API is single-valued, so a repeated
// header reads as its values joined (issue #2466).
Headers script_request_header_view (const ContextData& data) {
    return script_request_header_lines (data).folded ();
}

// ============================================================================
// pm.request.url - the Url object's members
// ============================================================================

void build_request_url_members (JSContext* ctx, JSValue url, RequestUrlState& state);

// `this` is the Url object each of these was reached through; a method called
// bare has no state, a script error, as for the header methods. The parts are
// built here rather than assumed: the only way to hold this object is the
// building accessor, but `getHost()` reading unbuilt parts would answer `""`
// for a real host, and a rule resting on how the object is reached breaks
// silently with a later change. Built already, this costs a branch.
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
    // And current with arrays the script mutated since: without this,
    // `path.push(...)` then `getPath()` answers the pre-edit path, and a script
    // that edits and then signs would sign a URL it is not sending.
    if (auto reason = refresh_url_from_members (ctx, this_val, *state)) {
        JS_ThrowTypeError (ctx, "%s", reason->c_str ());
        return nullptr;
    }
    return state;
}

/**
 * The whole URL, the one answer behind every string context: `toString`,
 * `valueOf`, `toJSON` and `@@toPrimitive` land here, so concatenation, a
 * template literal, `==` against a string, `JSON.stringify` and
 * `String.prototype`'s generic methods (coercing through `ToString(this)`)
 * behave as they did on a string. `@@toPrimitive`'s hint is ignored on purpose:
 * a URL has one primitive form, and another answer to a number hint would make
 * `+url` a different surprise.
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

/// The whole-URL and part readers, told apart by their magic - readers of the
/// same state that differ only in which part they join.
enum UrlPartGetter : int {
    URL_GET_HOST,
    URL_GET_PATH,
    URL_GET_QUERY_STRING,
    URL_GET_RAW,
    URL_GET_PATH_WITH_QUERY,
    URL_GET_REMOTE,
};

/// Indexed by `UrlPartGetter`; also the names the objects are given.
constexpr std::array<const char*, 6> URL_PART_GETTER_NAMES = { "getHost",
    "getPath", "getQueryString", "getRaw", "getPathWithQuery", "getRemote" };

/// `getPathWithQuery()` joins the path to its query only when there is one, so a
/// URL with no query is exactly `getPath()`.
std::string url_path_with_query (const vayu::http::UrlParts& parts) {
    std::string out = vayu::http::join_path (parts.path);
    if (!parts.query.empty ()) {
        out += '?';
        out += parts.query;
    }
    return out;
}

/// `getRemote()` is the host and the port the URL states: a scheme's default
/// port is never filled in, because `parse_url_parts` does not either.
std::string url_remote (const vayu::http::UrlParts& parts) {
    std::string out = vayu::http::join_host (parts.host);
    if (!parts.port.empty ()) {
        out += ':';
        out += parts.port;
    }
    return out;
}

std::string url_part_text (const RequestUrlState& state, int magic) {
    switch (magic) {
    case URL_GET_HOST: return vayu::http::join_host (state.parts.host);
    case URL_GET_PATH: return vayu::http::join_path (state.parts.path);
    case URL_GET_RAW: return state.text;
    case URL_GET_PATH_WITH_QUERY: return url_path_with_query (state.parts);
    case URL_GET_REMOTE: return url_remote (state.parts);
    default: return state.parts.query;
    }
}

JSValue
js_url_part_getter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)argc;
    (void)argv;
    auto* state = url_state_of_this (
    ctx, this_val, URL_PART_GETTER_NAMES.at (static_cast<size_t> (magic)));
    if (!state) {
        return JS_EXCEPTION;
    }
    const std::string out = url_part_text (*state, magic);
    return JS_NewStringLen (ctx, out.data (), out.size ());
}

/**
 * `url.update(newUrl)`: Postman's whole-URL write, the one
 * `pm.request.url = '...'` performs. In place, not a new object, as Postman's
 * is: a script holding the URL from before must see the update through it, or
 * the write-back and the script disagree on what is sent.
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

/// The Url object a query method was bound to: `this` is the `url.query`
/// sub-object, so the URL comes through the bound data, one source of truth for
/// the parsed params rather than a copy on the query object.
RequestUrlState* url_state_of_query (JSContext* ctx, JSValue* func_data, const char* member) {
    auto* state = request_url_state (func_data[0]);
    if (!state) {
        JS_ThrowInternalError (ctx, "pm.request.url.query.%s lost its URL", member);
        return nullptr;
    }
    // As for the url's own methods: a `path.push` before a `query.get` must not
    // leave the two members describing different URLs.
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

/// The first param named @p name, or nullptr when there is none.
const vayu::http::UrlQueryParam*
find_query_row (const RequestUrlState& state, const QueryParamName& name) {
    for (const auto& param : state.parts.query_params) {
        if (name.matches (param.key)) {
            return &param;
        }
    }
    return nullptr;
}

/// The value of the first param named @p name, or nullptr when there is none.
const std::optional<std::string>*
find_query_param (const RequestUrlState& state, const QueryParamName& name) {
    const auto* row = find_query_row (state, name);
    return row != nullptr ? &row->value : nullptr;
}

/**
 * `query.get(name)`: the first match's value, `null` when the name is absent or
 * for a bare `?flag`. First, as postman-collection's `PropertyList.one`
 * answers: a duplicated key is where a "last wins" guess would silently sign
 * the wrong string. `toObject()` is the last-wins view, and says so.
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

/// Every param as the `{ key, value }` array `all()` hands back. The iterating
/// reads walk this same list, built once up front, so a callback that edits the
/// URL (`query.add`, `url.update`) changes the state behind it and never the
/// walk in progress (#3462).
JSValue query_member_list (JSContext* ctx, const RequestUrlState& state) {
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& param : state.parts.query_params) {
        JS_SetPropertyUint32 (ctx, list, next++, query_param_entry (ctx, param));
    }
    return list;
}

/**
 * `query.all()`: every param in wire order, duplicates kept, the
 * canonicalization workhorse: an HMAC over a sorted query must see the params
 * as sent, which a `{name: value}` map cannot give.
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
    return query_member_list (ctx, *state);
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
 * Refuses a member edit on a URL with no members (#1040): `parse_url_parts`
 * leaves every part empty for an unreadable URL, so a write would compose a
 * plausible URL from nothing (`://` and what was pushed) and send it. No honest
 * edit exists, so it is an error, not a no-op. A `{{baseUrl}}/...` URL is not
 * this case: its token reads as the host (#3454).
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

/// A member write happened, so the parts are ahead of the text; recomposing the
/// raw query and the URL is `refresh_url_from_members`' job when someone needs
/// the whole URL.
void mark_url_edited (RequestUrlState& state) {
    state.dirty = true;
}

/// A `{ ... }` argument: an object a script wrote, not an array or a function
/// (both of which are objects to QuickJS).
bool is_plain_object (JSContext* ctx, JSValueConst arg) {
    return JS_IsObject (arg) && !JS_IsArray (arg) && !JS_IsFunction (ctx, arg);
}

/// One `{key, value}` argument of a query writer, read the way `all()` hands
/// them back. A missing `value` is a bare key, which is the `?flag` form.
/// @p api is the full name a refusal reports (`pm.request.url.query.add`).
bool read_query_param_arg (JSContext* ctx,
JSValueConst arg,
const char* api,
vayu::http::UrlQueryParam& out) {
    if (!is_plain_object (ctx, arg)) {
        JS_ThrowTypeError (ctx, "%s needs a { key, value } object, got %s", api,
        js_type_name (ctx, arg));
        return false;
    }
    ScopedValue key (ctx, JS_GetPropertyStr (ctx, arg, "key"));
    if (!JS_IsString (key.get ())) {
        JS_ThrowTypeError (ctx, "%s needs a string key, got %s", api,
        js_type_name (ctx, key.get ()));
        return false;
    }
    out.key = js_to_string (ctx, key.get ());
    if (out.key.empty ()) {
        JS_ThrowTypeError (ctx, "%s needs a non-empty key", api);
        return false;
    }
    ScopedValue value (ctx, JS_GetPropertyStr (ctx, arg, "value"));
    if (JS_IsUndefined (value.get ()) || JS_IsNull (value.get ())) {
        out.value = std::nullopt; // a bare `?key`
        return true;
    }
    if (!JS_IsString (value.get ()) && !JS_IsNumber (value.get ()) &&
    !JS_IsBool (value.get ())) {
        JS_ThrowTypeError (ctx, "%s value must be a string, number, boolean or null, got %s",
        api, js_type_name (ctx, value.get ()));
        return false;
    }
    out.value = js_to_string (ctx, value.get ());
    return true;
}

/// Encoded as the send would write it (#1773): the rows hold wire bytes, so
/// `all` and `getQueryString()` read what goes out. Postman adds a row and
/// `normalizeParam` writes it, so the per-row rule applies; a request sending
/// its URL as typed keeps the row as typed.
void encode_query_param_for_wire (JSContext* ctx, vayu::http::UrlQueryParam& param) {
    if (!script_query_is_encoded (ctx)) {
        return;
    }
    param.key =
    vayu::core::encode_query_component (param.key, vayu::core::QueryPart::Key);
    if (param.value) {
        param.value = vayu::core::encode_query_component (
        *param.value, vayu::core::QueryPart::Value);
    }
}

/// `add` appends even when the key exists (a query may repeat one, which is why
/// `all()` exists); `upsert` replaces the first match in place, keeping wire
/// position, and appends when there is none.
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
    const char* api = magic == QUERY_ADD ? "pm.request.url.query.add" :
                                           "pm.request.url.query.upsert";
    if (!read_query_param_arg (ctx, argv[0], api, param)) {
        return JS_EXCEPTION;
    }
    // Named before the encode: a row is looked up by the name as typed.
    const QueryParamName name (ctx, param.key);
    encode_query_param_for_wire (ctx, param);
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

/// `remove(name)` takes **every** param of that name: a caller removing `page`
/// and getting one of two back has removed nothing observable, and would have
/// to loop to find out.
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

// ----------------------------------------------------------------------------
// The rest of the PropertyList reads (each, map, filter, find, one, indexOf,
// idx; #3462), all over the `all()` rows, so a callback gets the
// `{ key, value }` a script already knows.
// ----------------------------------------------------------------------------

/// The four reads that hand every member to a callback.
enum QueryWalk : int { QUERY_EACH, QUERY_MAP, QUERY_FILTER, QUERY_FIND };

constexpr std::array<const char*, 4> QUERY_WALK_NAMES = { "each", "map", "filter", "find" };

/// What one callback answer adds to the result of the walk it belongs to:
/// `map` keeps the answer, `filter` keeps the member when the answer is truthy.
/// `each` and `find` collect nothing here.
void collect_query_walk_answer (JSContext* ctx,
int magic,
JSValueConst item,
JSValueConst answer,
JSValueConst collected,
uint32_t& next) {
    if (magic == QUERY_MAP) {
        JS_SetPropertyUint32 (ctx, collected, next++, JS_DupValue (ctx, answer));
    } else if (magic == QUERY_FILTER && JS_ToBool (ctx, answer) > 0) {
        JS_SetPropertyUint32 (ctx, collected, next++, JS_DupValue (ctx, item));
    }
}

/**
 * `query.each(fn, thisArg)`, `map`, `filter` and `find`: Postman's walks,
 * handing the callback `(member, index, list)` with the second argument as
 * `this`, as the header object's `each` does. `each` returns undefined and
 * visits every member (a `false` answer does not stop it, as on the header
 * object); `map` returns the answers, `filter` the members answered truthy,
 * `find` the first such member or `undefined`. The list is built before the
 * first call, so a callback editing the URL cannot change the walk under it; a
 * throw from the callback is the script's and ends the walk.
 */
JSValue js_url_query_walk (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    const char* member = QUERY_WALK_NAMES.at (static_cast<size_t> (magic));
    auto* state        = url_state_of_query (ctx, func_data, member);
    if (!state) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "pm.request.url.query.%s(fn) needs a function, got %s",
        member, argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    const ScopedValue list (ctx, query_member_list (ctx, *state));
    const auto count = static_cast<uint32_t> (state->parts.query_params.size ());
    const bool keeps = magic == QUERY_MAP || magic == QUERY_FILTER;
    const ScopedValue collected (ctx, keeps ? JS_NewArray (ctx) : JS_UNDEFINED);
    const JSValueConst this_arg = argc >= 2 ? argv[1] : JS_UNDEFINED;
    uint32_t next               = 0;
    for (uint32_t i = 0; i < count; i++) {
        const ScopedValue item (ctx, JS_GetPropertyUint32 (ctx, list.get (), i));
        JSValueConst args[3]{ item.get (),
            JS_NewInt32 (ctx, static_cast<int32_t> (i)), list.get () };
        const ScopedValue answer (ctx, JS_Call (ctx, argv[0], this_arg, 3, args));
        if (JS_IsException (answer.get ())) {
            return JS_EXCEPTION;
        }
        if (magic == QUERY_FIND && JS_ToBool (ctx, answer.get ()) > 0) {
            return JS_DupValue (ctx, item.get ());
        }
        collect_query_walk_answer (
        ctx, magic, item.get (), answer.get (), collected.get (), next);
    }
    return JS_DupValue (ctx, collected.get ());
}

/// `query.one(name)` - the first param's `{ key, value }` rather than its value,
/// `undefined` when the name is absent. `get` is the value half of the lookup,
/// and first-match for the same reason.
JSValue js_url_query_one (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "one");
    if (!state) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "pm.request.url.query.one needs a name string, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    const QueryParamName name (ctx, js_to_string (ctx, argv[0]));
    const auto* row = find_query_row (*state, name);
    return row != nullptr ? query_param_entry (ctx, *row) : JS_UNDEFINED;
}

/// The position of the first param @p wanted names, or -1. With @p value set
/// the param must also hold that value (`nullopt` being a bare key's).
int64_t index_of_query_param (const RequestUrlState& state,
const QueryParamName& wanted,
bool match_value,
const std::optional<std::string>& value) {
    const auto& rows = state.parts.query_params;
    for (size_t i = 0; i < rows.size (); i++) {
        if (wanted.matches (rows[i].key) && (!match_value || value == rows[i].value)) {
            return static_cast<int64_t> (i);
        }
    }
    return -1;
}

/**
 * `query.indexOf(item)`: the position in `all()`, `-1` when absent. Postman
 * finds a member by identity, but these members are built per call, so identity
 * would answer `-1` for this very list's member. A `{ key, value }` matches on
 * both, telling a repeated key's rows apart (`page=2&page=3`: the second `page`
 * is 1); a name matches the key alone, as `one` finds it.
 */
JSValue js_url_query_index_of (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)magic;
    constexpr const char* API = "pm.request.url.query.indexOf";
    auto* state               = url_state_of_query (ctx, func_data, "indexOf");
    if (!state) {
        return JS_EXCEPTION;
    }
    if (argc >= 1 && JS_IsString (argv[0])) {
        const QueryParamName name (ctx, js_to_string (ctx, argv[0]));
        return JS_NewInt64 (ctx, index_of_query_param (*state, name, false, std::nullopt));
    }
    if (argc < 1 || !is_plain_object (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "%s needs a name string or a { key, value } member, got %s",
        API, argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    vayu::http::UrlQueryParam wanted;
    if (!read_query_param_arg (ctx, argv[0], API, wanted)) {
        return JS_EXCEPTION;
    }
    const QueryParamName name (ctx, wanted.key);
    return JS_NewInt64 (ctx, index_of_query_param (*state, name, true, wanted.value));
}

/// `query.idx(n)` - the n-th `{ key, value }` of `all()`, `undefined` past
/// either end. Postman's is `members[n]`, so a fraction or a NaN names nothing.
JSValue js_url_query_idx (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)magic;
    auto* state = url_state_of_query (ctx, func_data, "idx");
    if (!state) {
        return JS_EXCEPTION;
    }
    double wanted = 0;
    if (argc < 1 || !JS_IsNumber (argv[0]) || JS_ToFloat64 (ctx, &wanted, argv[0]) < 0) {
        return JS_ThrowTypeError (ctx, "pm.request.url.query.idx needs an index number, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    const auto& rows = state->parts.query_params;
    if (!(wanted >= 0) || wanted >= static_cast<double> (rows.size ()) ||
    wanted != std::floor (wanted)) {
        return JS_UNDEFINED;
    }
    return query_param_entry (ctx, rows[static_cast<size_t> (wanted)]);
}

// ----------------------------------------------------------------------------
// url.addQueryParams / url.removeQueryParams - Postman's Url-level spellings of
// query.add and query.remove, taking several params at once.
// ----------------------------------------------------------------------------

constexpr const char* ADD_QUERY_PARAMS_API = "pm.request.url.addQueryParams";
constexpr const char* REMOVE_QUERY_PARAMS_API =
"pm.request.url.removeQueryParams";

/// Calls @p visit(item, index) on each element of the array @p list and stops
/// at the first one it refuses (it has thrown by then). Every element is read
/// before the caller writes anything, which is what keeps a refusal from
/// leaving half an edit behind.
template <typename Visit>
bool for_each_array_item (JSContext* ctx, JSValueConst list, const char* api, Visit&& visit) {
    int64_t length = 0;
    if (JS_GetLength (ctx, list, &length) < 0) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        JS_ThrowTypeError (ctx, "%s could not read its array", api);
        return false;
    }
    for (int64_t i = 0; i < length; i++) {
        const ScopedValue item (ctx, JS_GetPropertyInt64 (ctx, list, i));
        if (!visit (item.get (), i)) {
            return false;
        }
    }
    return true;
}

/// A key parsed out of a string names nothing when it is empty (`=1`), the same
/// rule `query.add` holds an object's key to.
bool require_query_key (JSContext* ctx, const vayu::http::UrlQueryParam& param, const char* api) {
    if (!param.key.empty ()) {
        return true;
    }
    JS_ThrowTypeError (ctx, "%s needs a non-empty key", api);
    return false;
}

/// A whole query string. One leading `?` is dropped so the query of a URL can
/// be passed as it reads; Postman keeps it, in the first key.
bool read_query_string_arg (JSContext* ctx,
JSValueConst arg,
const char* api,
std::vector<vayu::http::UrlQueryParam>& out) {
    std::string text = js_to_string (ctx, arg);
    if (text.starts_with ('?')) {
        text.erase (0, 1);
    }
    out = vayu::http::parse_query_params (text);
    return std::ranges::all_of (out, [&] (const vayu::http::UrlQueryParam& param) {
        return require_query_key (ctx, param, api);
    });
}

/// One element of an array argument: a `{ key, value }` object as `query.add`
/// takes it, or a string holding exactly one param (`a=1`, never `a=1&b=2`).
bool read_query_array_item (JSContext* ctx,
JSValueConst item,
int64_t index,
const char* api,
std::vector<vayu::http::UrlQueryParam>& out) {
    vayu::http::UrlQueryParam param;
    if (JS_IsString (item)) {
        param = vayu::http::parse_query_param (js_to_string (ctx, item));
        if (!require_query_key (ctx, param, api)) {
            return false;
        }
    } else if (!is_plain_object (ctx, item)) {
        JS_ThrowTypeError (ctx, "%s items must be strings or { key, value } objects, got %s at index %lld",
        api, js_type_name (ctx, item), static_cast<long long> (index));
        return false;
    } else if (!read_query_param_arg (ctx, item, api, param)) {
        return false;
    }
    out.push_back (std::move (param));
    return true;
}

/// What `addQueryParams` takes: a query string, an array of strings and
/// `{ key, value }` objects, or one `{ key, value }` object.
bool read_query_params_arg (JSContext* ctx,
JSValueConst arg,
const char* api,
std::vector<vayu::http::UrlQueryParam>& out) {
    if (JS_IsString (arg)) {
        return read_query_string_arg (ctx, arg, api, out);
    }
    if (JS_IsArray (arg)) {
        return for_each_array_item (ctx, arg, api, [&] (JSValueConst item, int64_t index) {
            return read_query_array_item (ctx, item, index, api, out);
        });
    }
    if (!is_plain_object (ctx, arg)) {
        JS_ThrowTypeError (ctx, "%s needs a query string, an array of params or a { key, value } object, got %s",
        api, js_type_name (ctx, arg));
        return false;
    }
    vayu::http::UrlQueryParam param;
    if (!read_query_param_arg (ctx, arg, api, param)) {
        return false;
    }
    out.push_back (std::move (param));
    return true;
}

JSValue js_url_add_query_params (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = url_state_of_this (ctx, this_val, "addQueryParams");
    if (!state || !require_parsed_url (ctx, *state, "addQueryParams")) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "%s needs a query string, an array of params or a { key, value } object",
        ADD_QUERY_PARAMS_API);
    }
    std::vector<vayu::http::UrlQueryParam> added;
    if (!read_query_params_arg (ctx, argv[0], ADD_QUERY_PARAMS_API, added)) {
        return JS_EXCEPTION;
    }
    if (added.empty ()) {
        return JS_UNDEFINED;
    }
    for (auto& param : added) {
        encode_query_param_for_wire (ctx, param);
        state->parts.query_params.push_back (std::move (param));
    }
    mark_url_edited (*state);
    return JS_UNDEFINED;
}

/// One name `removeQueryParams` is asked to drop: a string, or the `{ key }` of
/// a param as `query.all()` hands it back.
bool read_query_param_name (JSContext* ctx,
JSValueConst item,
const char* api,
std::vector<QueryParamName>& out) {
    std::string name;
    if (JS_IsString (item)) {
        name = js_to_string (ctx, item);
    } else if (is_plain_object (ctx, item)) {
        const ScopedValue key (ctx, JS_GetPropertyStr (ctx, item, "key"));
        if (!JS_IsString (key.get ())) {
            JS_ThrowTypeError (ctx, "%s needs a string key, got %s", api,
            js_type_name (ctx, key.get ()));
            return false;
        }
        name = js_to_string (ctx, key.get ());
    } else {
        JS_ThrowTypeError (ctx, "%s needs a name string or a { key } object, got %s",
        api, js_type_name (ctx, item));
        return false;
    }
    if (name.empty ()) {
        JS_ThrowTypeError (ctx, "%s needs a non-empty name", api);
        return false;
    }
    out.emplace_back (ctx, std::move (name));
    return true;
}

/// What `removeQueryParams` takes: a name, or an array of names and `{ key }`
/// objects. A lone object is refused where Postman's matches nothing, so a
/// script that passes `{ key: 'page' }` is told rather than left with `page`.
bool read_query_param_names_arg (JSContext* ctx,
JSValueConst arg,
const char* api,
std::vector<QueryParamName>& out) {
    if (JS_IsArray (arg)) {
        return for_each_array_item (ctx, arg, api, [&] (JSValueConst item, int64_t) {
            return read_query_param_name (ctx, item, api, out);
        });
    }
    if (!JS_IsString (arg)) {
        JS_ThrowTypeError (ctx, "%s needs a name string or an array of names, got %s",
        api, js_type_name (ctx, arg));
        return false;
    }
    return read_query_param_name (ctx, arg, api, out);
}

/// Removes **every** param of each name, as `query.remove` does for one.
JSValue js_url_remove_query_params (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = url_state_of_this (ctx, this_val, "removeQueryParams");
    if (!state || !require_parsed_url (ctx, *state, "removeQueryParams")) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_ThrowTypeError (ctx,
        "%s needs a name string or an array of names", REMOVE_QUERY_PARAMS_API);
    }
    std::vector<QueryParamName> names;
    if (!read_query_param_names_arg (ctx, argv[0], REMOVE_QUERY_PARAMS_API, names)) {
        return JS_EXCEPTION;
    }
    auto& params        = state->parts.query_params;
    const size_t before = params.size ();
    std::erase_if (params, [&names] (const vayu::http::UrlQueryParam& param) {
        return std::ranges::any_of (names, [&param] (const QueryParamName& name) {
            return name.matches (param.key);
        });
    });
    // A name that is not there is a no-op, as for `query.remove`.
    if (params.size () != before) {
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
    static constexpr std::array<QueryMethod, 16> METHODS = {
        QueryMethod{ "get", js_url_query_get, 1, 0 },
        QueryMethod{ "has", js_url_query_get, 1, 1 },
        QueryMethod{ "all", js_url_query_all, 0, 0 },
        QueryMethod{ "toObject", js_url_query_to_object, 0, 0 },
        QueryMethod{ "count", js_url_query_count, 0, 0 },
        QueryMethod{ "add", js_url_query_add, 1, QUERY_ADD },
        QueryMethod{ "upsert", js_url_query_add, 1, QUERY_UPSERT },
        QueryMethod{ "remove", js_url_query_remove, 1, 0 },
        QueryMethod{ "clear", js_url_query_clear, 0, 0 },
        QueryMethod{ "each", js_url_query_walk, 1, QUERY_EACH },
        QueryMethod{ "map", js_url_query_walk, 1, QUERY_MAP },
        QueryMethod{ "filter", js_url_query_walk, 1, QUERY_FILTER },
        QueryMethod{ "find", js_url_query_walk, 1, QUERY_FIND },
        QueryMethod{ "one", js_url_query_one, 1, 0 },
        QueryMethod{ "indexOf", js_url_query_index_of, 1, 0 },
        QueryMethod{ "idx", js_url_query_idx, 1, 0 },
    };
    for (const auto& method : METHODS) {
        JS_SetPropertyStr (ctx, query, method.name,
        JS_NewCFunctionData (ctx, method.fn, method.length, method.magic, 1, &url));
    }

    // No `members` array beside them: Postman's PropertyList has one, but here
    // it would be a second view of the params. `all()` is that view, and every
    // walk (`each`, `map`, `filter`, `find`) hands out the same
    // `{ key, value }` rows, plain objects, not Postman's QueryParam objects
    // with methods.
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
 * Parses `state.text` and (re)defines the members a script reads, on the first
 * read of `pm.request.url` and after every write, so members and string cannot
 * disagree. Redefined, not patched: a URL with no fragment must not keep the
 * previous `hash`. An unreadable URL leaves every part empty
 * (`parse_url_parts`) and the string intact on purpose: `toString()` still
 * answers, while a script reading parts gets nothing rather than a plausible
 * half.
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
 * `url.protocol = 'http'`, `url.port = '8443'`, `url.hash = 'top'`, as
 * accessors because a writable data property would take the assignment and
 * reach nothing. No read-only case to keep: a test script's `pm.request` is a
 * record nothing writes back, a property of the hook, not the member.
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
        // Every other part may be cleared; a URL with no scheme is one
        // `parse_url_parts` would not read back unless a token stood in for it.
        return JS_ThrowTypeError (ctx, "pm.request.url.protocol must not be empty");
    }
    url_string_part (*state, magic) = std::move (value);
    mark_url_edited (*state);
    return JS_UNDEFINED;
}

/// `url.length`: the current URL's length, read-only. A throwing setter would
/// be noise and a silently accepting one this issue's defect, so it has no
/// setter, and an assignment is JavaScript's ordinary no-op.
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

    // **Defined, not set.** The prototype is `String.prototype`, a String
    // object holding "" with a non-writable own `length`, so
    // `JS_SetPropertyStr` (`[[Set]]`, walking the chain) is refused by it.
    // Defining puts the property on this object without consulting the
    // prototype, as every member wants: these are the URL's own facts.
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
    // `length` is defined, not left a documented break: inherited from that
    // String prototype it would answer `0`, a plausible number for a non-empty
    // URL, the silent-wrong-answer class this program closes.
    define_accessor ("length", js_url_length_get, nullptr, 0);
    // Plain arrays, not accessors or proxies: like `pm.request.headers`, they
    // are read back by the write-back, which answers every segment edit at once
    // (push, splice, index assignment, length truncation, a replaced array). A
    // proxy would intercept each write, and `JS_IsArray` answers on the class
    // id, so `pm.expect(url.host).to.include(...)` would no longer see an array
    // (`refresh_url_from_members`).
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
        // The object is not of this class, so no finalizer will free the state.
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
    define ("addQueryParams",
    JS_NewCFunction (ctx, js_url_add_query_params, "addQueryParams", 1));
    define ("removeQueryParams",
    JS_NewCFunction (ctx, js_url_remove_query_params, "removeQueryParams", 1));
    for (size_t magic = 0; magic < URL_PART_GETTER_NAMES.size (); magic++) {
        const char* name = URL_PART_GETTER_NAMES.at (magic);
        define (name,
        JS_NewCFunctionMagic (ctx, js_url_part_getter, name, 0,
        JS_CFUNC_generic_magic, static_cast<int> (magic)));
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
 * `pm.request.url = '...'`, feeding `apply_pm_request_writeback`. Anything
 * neither a string nor a Url object is refused at the assignment, not by the
 * write-back lines later: the author is told which line was wrong, and a test
 * script, with no write-back to reject it, does not silently accept a number.
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
 * Installs `pm.request.url` as the accessor pair over a Url object. The parse
 * is paid on the first read, so a script never mentioning the URL (most) costs
 * one allocation; a write goes through the setter, leaving a Url object rather
 * than a bare string, which would make
 * `pm.request.url = x; pm.request.url.query.get('a')` throw. Enumerable like
 * every `pm.request` member, so `JSON.stringify` and `console.log` show the
 * URL, the string its `toJSON` answers.
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
 * The Postman mode name this body reads as. Five, the shapes a script can act
 * on: a string to parse, a pair list, a multipart part list, a GraphQL
 * operation and a file. Vayu's other content modes (`json`, `text`, `xml`,
 * `jsonrpc`, `mcp`) carry one string, which is `raw`, so a lifted
 * `body.mode === 'raw'` guard holds for each.
 *
 * `graphql` promises a `{query, variables}` member while the engine stores one
 * string, an envelope or a bare document; the pair is derivable by the rule the
 * send uses, `graphql_body.hpp`'s classifier (#1111; `body_graphql_view`). A
 * `binary` body is Postman's `file`: one file as the whole body. Postman's
 * `file` member promises `src`, the path, never answered here (a path is one
 * machine's filesystem, the form-data file part's rule, #411,
 * `declared_file_name`); it answers `{name, size?}` (`body_file_view`).
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
        // No `value` at all, not the `""` a file part holds: an empty string
        // reads as an empty text field, the distinction
        // `render_form_data_parts` keeps (#411). A script sees the name the
        // server is told, never the path (`declared_file_name`).
        define ("type", JS_NewString (ctx, "file"));
        define_text ("fileName", vayu::http::declared_file_name (field));
    } else {
        define_text ("value", field.value);
        if (multipart) {
            define ("type", JS_NewString (ctx, "text"));
        }
    }
    // Disabled rows are listed, unlike in the string view: a script inspects
    // the request with this list, and a row it cannot see is one it would
    // re-add. The flag says the row is not sent.
    define ("disabled", JS_NewBool (ctx, !field.enabled));
    (void)JS_PreventExtensions (ctx, entry);
    return entry;
}

/**
 * The read-only list `.urlencoded` / `.formdata` answer with: not extensible,
 * entries not writable, so `push`, `splice` and a field assignment throw rather
 * than edit a list nothing reads back. Writes go through a whole-body string,
 * `.raw` or `update ()`; a list quietly accepting edits would be the
 * silent-wrong shape again.
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
 * `.graphql`: Postman's `{query, variables}`, read off the one string. A
 * GraphQL body is either the `{"query": ...}` envelope the request builder
 * writes or the bare document an agent or `curl` hands over, and
 * `graphql_body.hpp` decides which; this asks that classifier, not a copy, so
 * `.graphql.query` is the query the send carries (a copy could call one body an
 * envelope here and a document at the wire). Three answers:
 *
 * - A readable envelope: its `query`, and `variables` when it has them.
 * - A bare document: `{query: <the document>}`, what wrapping it sends.
 * - Object-shaped text that does not parse (an unresolved `{{token}}`, a typo)
 *   or nests past `constants::request_body::MAX_JSON_DEPTH`: **undefined**.
 *   `graphql_wire_body` passes it through rather than guessing, and a pair
 *   invented here would be that guess; `.raw` still carries the string.
 *
 * An empty body answers `undefined`: `{query: ""}` would give a bodiless
 * request a query. `variables` is the envelope's JSON value, where Postman's is
 * its editor's text, a deliberate divergence: Vayu never stored that text, and
 * serializing one would invent whitespace and key order the user never wrote,
 * which `graphql_wire_body` refuses at the wire
 * (`docs/app/pm-api-compatibility.md`).
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
    // A string field the request-body depth bound (#2417) never looks inside,
    // and the `dump` below recurses (#2672). Past the bound is unreadable, as
    // `graphql_get_parameters` answers, so the two readers agree.
    if (vayu::json::exceeds_depth (document, vayu::core::constants::request_body::MAX_JSON_DEPTH)) {
        return JS_UNDEFINED;
    }
    // QuickJS gets what nlohmann read, never the bytes it read them from: the
    // grammars differ (a leading BOM is nlohmann's to skip and `JSON.parse`'s
    // to reject), so parsing twice would let the send carry a query this member
    // calls `undefined`. One reader has an opinion, the one the send asks; the
    // dump only transports.
    const std::string canonical =
    document.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    JSValue envelope = JS_ParseJSON (
    ctx, canonical.c_str (), canonical.size (), "<pm.request.body.graphql>");
    if (JS_IsException (envelope)) {
        // Unreachable: `canonical` is nlohmann's own output, and `replace`
        // keeps it valid JSON even for a lone continuation byte. Handled so no
        // parse error escapes a getter.
        JS_FreeValue (ctx, envelope);
        JSValue pending = JS_GetException (ctx);
        JS_FreeValue (ctx, pending);
        return JS_UNDEFINED;
    }
    JSValue query = JS_GetPropertyStr (ctx, envelope, "query");
    if (!JS_IsString (query)) {
        // Unreachable too: the classifier returned true on an undiscarded
        // parse, its "object with a string `query`" case, and the round trip
        // keeps the type; a guard keeps the function total.
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
 * `.file`: a binary body's file as a script may see it, `{name}` plus `size`
 * once the send has measured the file (the step that sets `FileRef::sha256`).
 * Never `src` (`postman_body_mode`); frozen like every descriptive member.
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
 * The urlencoded pairs the body carries now: the composed fields while `text`
 * is still their view, else `text` parsed back the way the write-back will
 * parse it. So the list follows a `.raw` or `update ()` write instead of
 * describing the body it replaced - the rule `.graphql` follows by reading
 * `text` too.
 */
std::vector<FormField> current_form_fields (const RequestBodyState& state) {
    if (state.text == script_body_view (state.body)) {
        return state.body.fields;
    }
    return vayu::http::parse_urlencoded (state.text);
}

/**
 * The body as a string, the one answer behind every string context (`toString`,
 * `valueOf`, `toJSON`, `@@toPrimitive`), for `js_url_to_string`'s reason:
 * string operations keep working as they did on a string.
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
    // undefined for the two form modes: the divergence #411 decided, as a form
    // body reading as nothing is indistinguishable from no body.
    case BODY_RAW:
        return JS_NewStringLen (ctx, state->text.data (), state->text.size ());
    case BODY_URLENCODED:
        return state->body.mode == BodyMode::Form ?
        body_field_list (ctx, current_form_fields (*state), /*multipart=*/false) :
        JS_UNDEFINED;
    case BODY_FORMDATA:
        return state->body.mode == BodyMode::FormData ?
        body_field_list (ctx, state->body.fields, /*multipart=*/true) :
        JS_UNDEFINED;
    // Read off `text`, not `body.content`, so after a `.raw` assignment it
    // reads the new string's pair: the two disagreeing would describe a body no
    // longer sent.
    case BODY_GRAPHQL:
        return state->body.mode == BodyMode::GraphQL ?
        body_graphql_view (ctx, state->text) :
        JS_UNDEFINED;
    case BODY_FILE:
        return state->body.mode == BodyMode::Binary ?
        body_file_view (ctx, state->body.file) :
        JS_UNDEFINED;
    // Defined, not inherited, as for the URL (#991): `String.prototype` holds
    // `""`, so an inherited `length` answers 0, plausible for a non-empty body,
    // and `docs/engine/scripting/console-and-examples.md` sets Content-Length
    // from it.
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
        // Members describing the body rather than carrying it, refused at the
        // assignment, not ignored: a script setting `.mode` or rebuilding
        // `.urlencoded` would send the original body and be told nothing.
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
    // Only the view moves: what assigning a body means (the untouched rule, the
    // urlencoded parse-back, the form-data refusal) is the write-back's,
    // reached alike from `.raw` or a whole-body assignment.
    state->text = js_to_string (ctx, argv[0]);
    return JS_UNDEFINED;
}

// ---------------------------------------------------------------------------
// Postman's body description - `{mode: 'raw', raw}` and
// `{mode: 'urlencoded', urlencoded}` (#3131)
// ---------------------------------------------------------------------------

/// The string view a description stands for, or why it was refused.
using BodyText = std::expected<std::string, std::string>;

/// A mode a description may name but a script cannot set, with what to do
/// instead: no string view carries a multipart part or a file, and a GraphQL
/// body is one string `.raw` already takes as its envelope.
struct UnsettableBodyMode {
    const char* mode;
    const char* instead;
};
constexpr auto UNSETTABLE_BODY_MODES = std::to_array<UnsettableBodyMode> ({
{ "formdata", "a multipart part is not a string; edit the request's form fields" },
{ "file", "a script never chooses the file a request sends; choose it in the request" },
{ "graphql", "assign pm.request.body.raw the {\"query\": ...} envelope instead" },
});

/**
 * Whether @p mode may describe a body whose mode is @p current. The write-back
 * keeps a request's body mode (`apply_pm_request_writeback`), so a description
 * naming another would be sent as the current one (`{mode: 'raw'}` on a
 * urlencoded body would be parsed back into fields); refused instead. A
 * bodyless request takes `raw`, sent as text, as a string assignment is.
 */
std::expected<void, std::string>
check_settable_body_mode (const std::string& mode, BodyMode current, const char* label) {
    for (const auto& unsettable : UNSETTABLE_BODY_MODES) {
        if (mode == unsettable.mode) {
            return std::unexpected (std::string (label) + ": { mode: '" + mode +
            "' } cannot be set from a script - " + unsettable.instead);
        }
    }
    if (mode != "raw" && mode != "urlencoded") {
        return std::unexpected (std::string (label) + ": unknown body mode '" + mode +
        "' - Postman's modes are raw, urlencoded, formdata, file and graphql");
    }
    const std::string held =
    current == BodyMode::None ? "raw" : postman_body_mode (current);
    if (mode == held) {
        return {};
    }
    const std::string what = current == BodyMode::None ?
    "this request has no body, and a body a script adds is raw text" :
    "this request's body is '" + held + "'";
    // A GraphQL body is one string, so its rewrite has a spelling that keeps
    // the mode, which `update ('...')` - Postman's `{ mode: 'raw' }` - is not.
    const std::string instead = current == BodyMode::GraphQL ?
    "Assign pm.request.body.raw the {\"query\": ...} envelope instead" :
    "Change the body type in the request instead";
    return std::unexpected (std::string (label) + ": { mode: '" + mode + "' } cannot be applied - " +
    what + ", and a script cannot change a body's mode. " + instead);
}

BodyText raw_description_text (JSContext* ctx, JSValueConst description, const char* label) {
    ScopedValue raw (ctx, JS_GetPropertyStr (ctx, description, "raw"));
    if (!JS_IsString (raw.get ())) {
        return std::unexpected (std::string (label) + ": { mode: 'raw' } needs raw to be a string, got " +
        js_type_name (ctx, raw.get ()));
    }
    return js_to_string (ctx, raw.get ());
}

/// One `{ key, value?, disabled? }` pair. A missing or null value is the empty
/// string Postman sends for it; a value that is not a primitive has no wire
/// form and is refused, as a header value is.
std::expected<FormField, std::string>
urlencoded_description_field (JSContext* ctx, JSValueConst entry, int64_t index, const char* label) {
    const std::string at =
    std::string (label) + ": urlencoded[" + std::to_string (index) + "]";
    if (!JS_IsObject (entry) || JS_IsArray (entry) || JS_IsFunction (ctx, entry)) {
        return std::unexpected (
        at + " must be a { key, value } object, got " + js_type_name (ctx, entry));
    }
    ScopedValue key (ctx, JS_GetPropertyStr (ctx, entry, "key"));
    ScopedValue value (ctx, JS_GetPropertyStr (ctx, entry, "value"));
    ScopedValue disabled (ctx, JS_GetPropertyStr (ctx, entry, "disabled"));
    if (!JS_IsString (key.get ()) || js_to_string (ctx, key.get ()).empty ()) {
        return std::unexpected (at + ".key must be a non-empty string, got " +
        js_type_name (ctx, key.get ()));
    }
    const bool absent = JS_IsUndefined (value.get ()) || JS_IsNull (value.get ());
    if (!absent && !JS_IsString (value.get ()) && !JS_IsNumber (value.get ()) &&
    !JS_IsBool (value.get ())) {
        return std::unexpected (at + ".value must be a string, number or boolean, got " +
        js_type_name (ctx, value.get ()));
    }
    return FormField{ js_to_string (ctx, key.get ()),
        absent ? std::string{} : js_to_string (ctx, value.get ()),
        JS_ToBool (ctx, disabled.get ()) != 1 };
}

/// The pairs encoded as the wire body - the string view a urlencoded body
/// reads as, so the write-back parses it straight back into these fields.
BodyText urlencoded_description_text (JSContext* ctx, JSValueConst description, const char* label) {
    ScopedValue list (ctx, JS_GetPropertyStr (ctx, description, "urlencoded"));
    if (!JS_IsArray (list.get ())) {
        return std::unexpected (std::string (label) + ": { mode: 'urlencoded' } needs urlencoded to be an array of { key, value }, got " +
        js_type_name (ctx, list.get ()));
    }
    int64_t length = 0;
    if (JS_GetLength (ctx, list.get (), &length) < 0) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return std::unexpected (std::string (label) + ": urlencoded could not be read");
    }
    std::vector<FormField> fields;
    fields.reserve (static_cast<size_t> (length < 0 ? 0 : length));
    for (int64_t i = 0; i < length; i++) {
        ScopedValue entry (ctx, JS_GetPropertyInt64 (ctx, list.get (), i));
        auto field = urlencoded_description_field (ctx, entry.get (), i, label);
        if (!field) {
            return std::unexpected (std::move (field.error ()));
        }
        fields.push_back (std::move (*field));
    }
    return vayu::http::encode_urlencoded (fields);
}

/**
 * The string view Postman's body description means for a body of mode
 * @p current. `body.update ()` takes a description and a lifted script assigns
 * one to `pm.request.body`; both land on the string view
 * (`RequestBodyState::text`) the write-back reads, so a description means what
 * assigning its string would. @p label names the surface in refusals.
 */
BodyText body_description_text (JSContext* ctx,
JSValueConst description,
BodyMode current,
const char* label) {
    ScopedValue js_mode (ctx, JS_GetPropertyStr (ctx, description, "mode"));
    if (!JS_IsString (js_mode.get ())) {
        return std::unexpected (std::string (label) +
        ": a body description needs a mode - { mode: 'raw', raw: '...' } or "
        "{ mode: 'urlencoded', urlencoded: [...] } - got mode " +
        js_type_name (ctx, js_mode.get ()));
    }
    const std::string mode = js_to_string (ctx, js_mode.get ());
    if (auto settable = check_settable_body_mode (mode, current, label); !settable) {
        return std::unexpected (std::move (settable.error ()));
    }
    return mode == "raw" ? raw_description_text (ctx, description, label) :
                           urlencoded_description_text (ctx, description, label);
}

/// What `update`'s argument means: a string is `{mode: 'raw', raw}`, as in
/// Postman, so it is held to the same mode rule as the description it stands
/// for.
BodyText
update_argument_text (JSContext* ctx, JSValueConst value, BodyMode current, const char* label) {
    if (!JS_IsString (value)) {
        return body_description_text (ctx, value, current, label);
    }
    if (auto settable = check_settable_body_mode ("raw", current, label); !settable) {
        return std::unexpected (std::move (settable.error ()));
    }
    return js_to_string (ctx, value);
}

/// `body.update (body)` - Postman's setter. Only the view moves, as for a
/// `.raw` assignment.
JSValue js_body_update (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    constexpr const char* label = "pm.request.body.update";
    auto* state                 = request_body_state (this_val);
    if (!state) {
        return JS_ThrowTypeError (ctx,
        "%s must be called on the request body object, not detached from it", label);
    }
    const bool takes = argc >= 1 &&
    (JS_IsString (argv[0]) ||
    (JS_IsObject (argv[0]) && !JS_IsArray (argv[0]) && !JS_IsFunction (ctx, argv[0])));
    if (!takes) {
        return JS_ThrowTypeError (ctx,
        "%s takes a string or { mode: 'raw', raw } / { mode: 'urlencoded', "
        "urlencoded }, got %s",
        label, argc > 0 ? js_type_name (ctx, argv[0]) : "no value");
    }
    BodyText text = update_argument_text (ctx, argv[0], state->body.mode, label);
    if (!text) {
        return JS_ThrowTypeError (ctx, "%s", text.error ().c_str ());
    }
    state->text = std::move (*text);
    return JS_UNDEFINED;
}

/**
 * A RequestBody object over @p body, with the Postman members. A plain property
 * on `pm.request`, not #991's accessor pair, the one departure from that
 * precedent: the URL needed an accessor so `pm.request.url = x` left a Url
 * object; for the body, a string assignment leaving a plain string is the
 * contract, and `null` and `delete` mean "send no body", which an accessor
 * would need an emptied-state flag to keep saying.
 */
JSValue new_request_body (JSContext* ctx, const Body& body) {
    JSValue object = JS_NewObjectClass (ctx, request_body_class_id);
    if (JS_IsException (object)) {
        return object;
    }
    auto* state = new RequestBodyState{ body, script_body_view (body) };
    if (JS_SetOpaque (object, state) < 0) {
        // The object is not of this class, so no finalizer will free the state.
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
    define ("update", JS_NewCFunction (ctx, js_body_update, "update", 1));
    JSAtom to_primitive = well_known_symbol_atom (ctx, "toPrimitive");
    JS_DefinePropertyValue (ctx, object, to_primitive,
    JS_NewCFunction (ctx, js_body_to_string, "[Symbol.toPrimitive]", 1),
    JS_PROP_CONFIGURABLE);
    JS_FreeAtom (ctx, to_primitive);

    // Accessors: a read comes from the state, a write reaches it or is refused
    // by name. `this` carries the state, so no bound data, and a getter called
    // on another object finds no state and throws.
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

/// A plain object naming a `mode` - the one object shape, besides the
/// RequestBody itself, that an assignment to `pm.request.body` reads.
bool is_body_description (JSContext* ctx, JSValueConst value) {
    if (!JS_IsObject (value) || JS_IsArray (value) || JS_IsFunction (ctx, value)) {
        return false;
    }
    JSAtom mode    = JS_NewAtom (ctx, "mode");
    const int held = JS_HasProperty (ctx, value, mode);
    JS_FreeAtom (ctx, mode);
    return held == 1;
}

/**
 * The body text a value carries, `script_url_text`'s sibling, for a request
 * whose body mode is @p current: a JS string is itself, a RequestBody its
 * string view (which a `.raw` assignment moved), Postman's `{mode, raw}`
 * description the view it stands for (`body_description_text`); anything else
 * is refused. Not "any object, via toString", for `script_url_text`'s reason; a
 * description is an explicit shape, recognised by `mode` and read member by
 * member.
 */
BodyText script_body_text (JSContext* ctx, JSValueConst value, BodyMode current) {
    if (JS_IsString (value)) {
        return js_to_string (ctx, value);
    }
    if (auto* state = request_body_state (value)) {
        return state->text;
    }
    if (is_body_description (ctx, value)) {
        return body_description_text (ctx, value, current, "pm.request.body");
    }
    return std::unexpected (
    "pm.request.body must be a string, the request body object or a Postman "
    "body description such as { mode: 'raw', raw: '...' }, got " +
    std::string (js_type_name (ctx, value)));
}

// ---------------------------------------------------------------------------
// pm.request's own methods - Postman's Request API (#3131)
// ---------------------------------------------------------------------------

/// `this` is the request a method was reached through; detached, it is not.
bool request_this_is_usable (JSContext* ctx, JSValueConst this_val, const char* method) {
    if (JS_IsObject (this_val) && !JS_IsFunction (ctx, this_val)) {
        return true;
    }
    JS_ThrowTypeError (ctx,
    "pm.request.%s must be called on pm.request (got %s), not detached from it",
    method, js_type_name (ctx, this_val));
    return false;
}

/**
 * `this.<member>.<method> (...args)`, for a Request method that is a member's
 * method under Postman's other name. Looked up at call time, not bound at
 * setup, so a script that replaced `pm.request.headers` is told so rather than
 * writing to an object the write-back no longer reads.
 */
JSValue call_member_method (JSContext* ctx,
JSValueConst request,
const char* caller,
const char* member,
const char* method,
int argc,
JSValueConst* argv) {
    if (!request_this_is_usable (ctx, request, caller)) {
        return JS_EXCEPTION;
    }
    ScopedValue target (ctx, JS_GetPropertyStr (ctx, request, member));
    if (JS_IsException (target.get ())) {
        return JS_EXCEPTION;
    }
    ScopedValue fn (ctx,
    JS_IsObject (target.get ()) ? JS_GetPropertyStr (ctx, target.get (), method) : JS_UNDEFINED);
    if (JS_IsException (fn.get ())) {
        return JS_EXCEPTION;
    }
    if (!JS_IsFunction (ctx, fn.get ())) {
        return JS_ThrowTypeError (ctx,
        "pm.request.%s() calls pm.request.%s.%s(), and pm.request.%s (%s) has "
        "no such method - it was replaced by something other than the object "
        "pm.request.%s started as",
        caller, member, method, member, js_type_name (ctx, target.get ()), member);
    }
    return JS_Call (ctx, fn.get (), target.get (), argc, argv);
}

/// A Request method that is a member's method by another name. `addHeader` is
/// `upsert`, not `add` (#3131): a lifted script calls it on a header the
/// request may carry, and a duplicate has nowhere to live in one value per
/// name.
struct RequestAlias {
    const char* name;
    const char* member;
    const char* method;
};
constexpr auto REQUEST_ALIASES = std::to_array<RequestAlias> ({
{ "addHeader", "headers", "upsert" },
{ "upsertHeader", "headers", "upsert" },
{ "removeHeader", "headers", "remove" },
{ "forEachHeader", "headers", "each" },
{ "addQueryParams", "url", "addQueryParams" },
{ "removeQueryParams", "url", "removeQueryParams" },
});

JSValue
js_request_alias (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    const auto& alias = REQUEST_ALIASES.at (static_cast<size_t> (magic));
    return call_member_method (
    ctx, this_val, alias.name, alias.member, alias.method, argc, argv);
}

/// `getHeaders (options?)` - Postman's is `headers.toObject` with the case
/// switch inverted: names keep their spelling unless `ignoreCase` lower-cases
/// them. Its other options (`enabled`, `multiValue`, `sanitizeKeys`) decide
/// nothing here, for the reasons `toObject` gives.
JSValue js_request_get_headers (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    bool ignore_case = false;
    if (argc >= 1 && JS_IsObject (argv[0])) {
        ScopedValue flag (ctx, JS_GetPropertyStr (ctx, argv[0], "ignoreCase"));
        ignore_case = JS_ToBool (ctx, flag.get ()) == 1;
    }
    JSValueConst args[2]{ JS_NewBool (ctx, 0), JS_NewBool (ctx, ignore_case ? 0 : 1) };
    return call_member_method (ctx, this_val, "getHeaders", "headers", "toObject", 2, args);
}

/// The header object as Postman's `header` list, `[{ key, value }]` in the
/// object's own key order.
JSValue request_json_header (JSContext* ctx, JSValueConst headers) {
    std::vector<std::string> keys;
    if (!JS_IsObject (headers) || JS_IsArray (headers) || JS_IsFunction (ctx, headers)) {
        return JS_ThrowTypeError (ctx,
        "pm.request.toJSON: pm.request.headers must be an object, got %s",
        js_type_name (ctx, headers));
    }
    if (!js_own_enumerable_keys (ctx, headers, keys)) {
        return JS_EXCEPTION;
    }
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& key : keys) {
        JSValue member = JS_NewObject (ctx);
        JS_SetPropertyStr (
        ctx, member, "key", JS_NewStringLen (ctx, key.data (), key.size ()));
        JS_SetPropertyStr (
        ctx, member, "value", JS_GetPropertyStr (ctx, headers, key.c_str ()));
        JS_SetPropertyUint32 (ctx, list, next++, member);
    }
    return list;
}

/**
 * The body as Postman's description: `{mode, <mode>: ...}` read off the
 * RequestBody's own members, so it says what those members say. A string is
 * the raw body it is sent as; a description the script assigned is already the
 * shape and is handed back as it stands.
 */
JSValue request_json_body (JSContext* ctx, JSValueConst body) {
    if (JS_IsString (body)) {
        JSValue out = JS_NewObject (ctx);
        JS_SetPropertyStr (ctx, out, "mode", JS_NewString (ctx, "raw"));
        JS_SetPropertyStr (ctx, out, "raw", JS_DupValue (ctx, body));
        return out;
    }
    auto* state = request_body_state (body);
    if (!state) {
        return JS_DupValue (ctx, body);
    }
    // Postman's mode names are the names of the members that carry each mode.
    const char* mode = postman_body_mode (state->body.mode);
    JSValue out      = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, out, "mode", JS_NewString (ctx, mode));
    JS_SetPropertyStr (ctx, out, mode, JS_GetPropertyStr (ctx, body, mode));
    return out;
}

/**
 * `toJSON ()`: the request as a plain object (`url`, `method`, `header`, `body`
 * when there is one, the assigned `auth` when there is one), read from
 * `pm.request` as it stands, so it describes what the write-back would send.
 * `url` is the string `pm.request.url.toJSON ()` gives, where Postman's is its
 * Url object's parts. As `toJSON`, it is what `JSON.stringify (pm.request)`
 * writes.
 */
JSValue js_request_to_json (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    if (!request_this_is_usable (ctx, this_val, "toJSON")) {
        return JS_EXCEPTION;
    }
    ScopedValue url (ctx, JS_GetPropertyStr (ctx, this_val, "url"));
    std::string url_error;
    auto url_text = script_url_text (ctx, url.get (), &url_error);
    if (!url_text) {
        if (url_error.empty ()) {
            url_error =
            "pm.request.url must be a string or a URL object, got " +
            std::string (js_type_name (ctx, url.get ()));
        }
        return JS_ThrowTypeError (ctx, "pm.request.toJSON: %s", url_error.c_str ());
    }
    ScopedValue headers (ctx, JS_GetPropertyStr (ctx, this_val, "headers"));
    JSValue header = request_json_header (ctx, headers.get ());
    if (JS_IsException (header)) {
        return header;
    }
    JSValue out = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, out, "url",
    JS_NewStringLen (ctx, url_text->data (), url_text->size ()));
    JS_SetPropertyStr (ctx, out, "method", JS_GetPropertyStr (ctx, this_val, "method"));
    JS_SetPropertyStr (ctx, out, "header", header);
    ScopedValue body (ctx, JS_GetPropertyStr (ctx, this_val, "body"));
    if (!JS_IsUndefined (body.get ()) && !JS_IsNull (body.get ())) {
        JS_SetPropertyStr (ctx, out, "body", request_json_body (ctx, body.get ()));
    }
    ScopedValue auth (ctx, JS_GetPropertyStr (ctx, this_val, "auth"));
    if (!JS_IsUndefined (auth.get ()) && !JS_IsNull (auth.get ())) {
        JS_SetPropertyStr (ctx, out, "auth", JS_DupValue (ctx, auth.get ()));
    }
    return out;
}

constexpr ScriptAuthSlot PM_REQUEST_AUTH{ "pm.request.auth", "pm.request.auth" };

/**
 * `{ type, <type>: params }` from what `authorizeUsing` was handed: a type and
 * its parameters, Postman's `{ type, ...params }`, or that shape already.
 * Throws, answering JS_EXCEPTION, for anything else.
 */
JSValue authorize_using_description (JSContext* ctx, JSValueConst type, JSValueConst options) {
    const bool has_options = !JS_IsUndefined (options) && !JS_IsNull (options);
    if (JS_IsString (type)) {
        JSValue out = JS_NewObject (ctx);
        JS_SetPropertyStr (ctx, out, "type", JS_DupValue (ctx, type));
        if (has_options) {
            const std::string name = js_to_string (ctx, type);
            JS_SetPropertyStr (ctx, out, name.c_str (), JS_DupValue (ctx, options));
        }
        return out;
    }
    if (!JS_IsObject (type) || JS_IsArray (type) || JS_IsFunction (ctx, type) || has_options) {
        return JS_ThrowTypeError (ctx,
        "pm.request.authorizeUsing takes (type, options?), "
        "({ type, ...options }) or null, got %s",
        js_type_name (ctx, type));
    }
    ScopedValue named (ctx, JS_GetPropertyStr (ctx, type, "type"));
    if (!JS_IsString (named.get ())) {
        return JS_ThrowTypeError (ctx,
        "pm.request.authorizeUsing needs a string 'type' (basic, bearer, "
        "apikey or noauth), got %s",
        js_type_name (ctx, named.get ()));
    }
    const std::string name = js_to_string (ctx, named.get ());
    ScopedValue block (ctx, JS_GetPropertyStr (ctx, type, name.c_str ()));
    if (!JS_IsUndefined (block.get ())) {
        // Already `{ type, <type>: params }`, the shape pm.request.auth takes.
        return JS_DupValue (ctx, type);
    }
    // Postman's `{ type, ...params }`: every other member is a parameter.
    std::vector<std::string> keys;
    if (!js_own_enumerable_keys (ctx, type, keys)) {
        return JS_EXCEPTION;
    }
    JSValue params = JS_NewObject (ctx);
    for (const auto& key : keys) {
        if (key != "type") {
            JS_SetPropertyStr (ctx, params, key.c_str (),
            JS_GetPropertyStr (ctx, type, key.c_str ()));
        }
    }
    JSValue out = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, out, "type", JS_DupValue (ctx, named.get ()));
    JS_SetPropertyStr (ctx, out, name.c_str (), params);
    return out;
}

/**
 * `authorizeUsing (type, options?)`: Postman's auth setter, assigning
 * `pm.request.auth`; `null` removes an assigned one, so the request's own auth
 * applies again. Read by the write-back's reader, so a type it would refuse
 * throws at the call, naming itself, where Postman ignores the call and sends
 * the request unauthenticated.
 */
JSValue js_request_authorize_using (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!request_this_is_usable (ctx, this_val, "authorizeUsing")) {
        return JS_EXCEPTION;
    }
    JSValueConst type    = argc >= 1 ? argv[0] : JS_UNDEFINED;
    JSValueConst options = argc >= 2 ? argv[1] : JS_UNDEFINED;
    if (JS_IsNull (type)) {
        const JSAtom auth = JS_NewAtom (ctx, "auth");
        const int deleted = JS_DeleteProperty (ctx, this_val, auth, 0);
        JS_FreeAtom (ctx, auth);
        return deleted < 0 ? JS_EXCEPTION : JS_UNDEFINED;
    }
    ScopedValue description (ctx, authorize_using_description (ctx, type, options));
    if (JS_IsException (description.get ())) {
        return JS_EXCEPTION;
    }
    vayu::http::Auth checked = vayu::http::NoAuth{};
    if (auto reason = read_script_auth (ctx, description.get (), PM_REQUEST_AUTH, checked)) {
        return JS_ThrowTypeError (ctx, "pm.request.authorizeUsing: %s", reason->c_str ());
    }
    if (JS_SetPropertyStr (
        ctx, this_val, "auth", JS_DupValue (ctx, description.get ())) < 0) {
        return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

/// Postman Request methods with no Vayu meaning, bound only to refuse by name:
/// unbound, a lifted call would die on a bare "not a function".
struct UnsupportedRequestMethod {
    const char* name;
    const char* instead;
};
constexpr auto UNSUPPORTED_REQUEST_METHODS = std::to_array<UnsupportedRequestMethod> ({
{ "clone", "pm.request.toJSON() returns a plain copy" },
{ "size", "read pm.request.body.length for the body's size" },
{ "update", "assign pm.request.url, .method, .headers or .body instead" },
});

JSValue
js_request_unsupported (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;
    const auto& method = UNSUPPORTED_REQUEST_METHODS.at (static_cast<size_t> (magic));
    return JS_ThrowTypeError (ctx,
    "pm.request.%s() is not supported in Vayu - %s", method.name, method.instead);
}

/**
 * Postman's Request methods on `pm.request`. Non-enumerable, as the header
 * methods are, so `Object.keys (pm.request)` still lists the request's own
 * four members and nothing a script would mistake for one.
 */
void install_request_methods (JSContext* ctx, JSValue request) {
    constexpr int flags = JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE;
    for (size_t i = 0; i < REQUEST_ALIASES.size (); i++) {
        const char* name = REQUEST_ALIASES.at (i).name;
        JS_DefinePropertyValueStr (ctx, request, name,
        JS_NewCFunctionMagic (ctx, js_request_alias, name, 1,
        JS_CFUNC_generic_magic, static_cast<int> (i)),
        flags);
    }
    JS_DefinePropertyValueStr (ctx, request, "getHeaders",
    JS_NewCFunction (ctx, js_request_get_headers, "getHeaders", 0), flags);
    JS_DefinePropertyValueStr (ctx, request, "toJSON",
    JS_NewCFunction (ctx, js_request_to_json, "toJSON", 0), flags);
    JS_DefinePropertyValueStr (ctx, request, "authorizeUsing",
    JS_NewCFunction (ctx, js_request_authorize_using, "authorizeUsing", 2), flags);
    for (size_t i = 0; i < UNSUPPORTED_REQUEST_METHODS.size (); i++) {
        const char* name = UNSUPPORTED_REQUEST_METHODS.at (i).name;
        JS_DefinePropertyValueStr (ctx, request, name,
        JS_NewCFunctionMagic (ctx, js_request_unsupported, name, 0,
        JS_CFUNC_generic_magic, static_cast<int> (i)),
        flags);
    }
}

} // namespace

void setup_pm_request (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    // A pooled context still holds the previous execution's object; free it.
    JSValue old_request = JS_GetPropertyStr (ctx, pm, "request");
    if (!JS_IsUndefined (old_request)) {
        JS_FreeValue (ctx, old_request);
    }

    JSValue request = JS_NewObject (ctx);

    if (data && data->request) {
        // pm.request.url - Postman's Url object.
        install_request_url (ctx, request, data->request->url);

        JS_SetPropertyStr (ctx, request, "method",
        JS_NewString (ctx, to_string (data->request->method)));

        // The object the write-back reads, so its methods and plain assignment
        // reach one property set; which set depends on the hook
        // (`script_request_header_view`).
        JSValue headers = JS_NewObject (ctx);
        install_header_methods (ctx, headers, /*mutators=*/true);
        for (const auto& [key, value] : script_request_header_view (*data)) {
            define_header_entry (ctx, headers, key, value);
        }
        JS_SetPropertyStr (ctx, request, "headers", headers);

        // Postman's RequestBody object (#1003), still reading as its string in
        // every context JavaScript allows, and the string is what an assignment
        // means. A bodyless request defines no property, so
        // `typeof pm.request.body` tells "no body" from "an empty body".
        if (data->request->body.mode != BodyMode::None) {
            JSValue body = new_request_body (ctx, data->request->body);
            if (JS_IsException (body)) {
                // The exception sentinel as a property would make
                // `pm.request.body` an object no read can touch; an unreachable
                // body reads as none, the honest degradation, as in
                // `install_request_url`.
                JS_FreeValue (ctx, body);
            } else {
                JS_SetPropertyStr (ctx, request, "body", body);
            }
        }

        install_request_methods (ctx, request);
    }

    JS_SetPropertyStr (ctx, pm, "request", request);
}

/**
 * `pm.info`: which request this script is attached to, and which hook. Rebuilt
 * per execution with pm.request / pm.response because contexts are pooled, and
 * a leftover would report the previous request's name. A field with no value is
 * left off, so a script reads `undefined`, not an empty string that looks like
 * an answer.
 *
 * `iteration` and `vu` are present wherever a real one exists: a scenario run's
 * steps, a load run's sampled response (#994), and a send that bound a data row
 * (row 0 of 1). `iterationCount` is narrower (the scenario runner's total, or
 * that send's `1`): no load run sets it, since a duration-bounded one has no
 * total and a field readable from one load shape and not another is worse than
 * one never readable there. An ordinary Send sets none of the three
 * (`ScriptContext`).
 */
void setup_pm_info (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    // Free the previous execution's object before replacing it, as
    // setup_pm_request and setup_pm_response do.
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

// ============================================================================
// pm.request write-back (pre-request scripts)
// ============================================================================

// Reads a header object into `out`, naming it @p label in every refusal. Two
// callers, the pm.request write-back and pm.sendRequest's object header form,
// because the rules (empty name, non-primitive value, a case-insensitive clash)
// belong to HTTP headers, not either surface. @p suggest_delete adds the
// removal hint that means something only for a live pm.request.headers.
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
        // An empty field-name, or a value with no honest wire form, is refused
        // by name, not dropped: a silently missing header is the defect this
        // write-back exists to fix.
        if (key.empty ()) {
            error = std::string (label) + " has an empty header name";
        } else if (JS_IsString (value.get ()) || JS_IsNumber (value.get ()) ||
        JS_IsBool (value.get ())) {
            // JS keys are case-sensitive, HTTP names not: `Authorization` and
            // `authorization` are two properties there and one header here, and
            // the last enumerated would silently win. Which was meant is
            // unknowable, and one is an Authorization header, so refuse rather
            // than guess.
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
 * The script's single-valued header object applied back onto the request's
 * lines (#2466). A name whose value the script left as read keeps every line it
 * had, in place and spelling, so a repeated header survives a script that never
 * touched it (the body's "unchanged means untouched" rule). A changed name
 * becomes one line where its first was; a removed name loses every line; a new
 * one is appended.
 */
HeaderList apply_script_headers (const HeaderList& lines, const Headers& written) {
    const Headers shown = lines.folded ();
    HeaderList out;
    for (const auto& line : lines) {
        const auto now = written.find (line.name);
        if (now == written.end ()) {
            continue;
        }
        if (now->second == shown.at (line.name)) {
            out.add (line.name, line.value);
        } else if (!out.contains (line.name)) {
            out.add (now->first, now->second);
        }
    }
    for (const auto& [name, value] : written) {
        if (!shown.contains (name)) {
            out.add (name, value);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// pm.request.auth (#3131)
// ---------------------------------------------------------------------------

/// A URL cut around its query: what precedes the `?`, the parsed pairs, and
/// the fragment, `#` included. `query` is nullopt for a URL with no `?`.
struct UrlQuerySplit {
    std::string head;
    std::optional<std::vector<vayu::http::UrlQueryParam>> query;
    std::string fragment;
};

UrlQuerySplit split_url_query (const std::string& url) {
    UrlQuerySplit out;
    const auto hash = url.find ('#');
    out.head        = url.substr (0, hash);
    if (hash != std::string::npos) {
        out.fragment = url.substr (hash);
    }
    if (const auto mark = out.head.find ('?'); mark != std::string::npos) {
        out.query = vayu::http::parse_query_params (
        std::string_view (out.head).substr (mark + 1));
        out.head.erase (mark);
    }
    return out;
}

/// The pair `apply_auth` appended for @p request's query credential: the last
/// one under its name, as typed or as the query rule encodes it.
std::optional<vayu::http::UrlQueryParam> engine_query_credential (const Request& request) {
    if (request.auth_query_param.empty ()) {
        return std::nullopt;
    }
    const std::string& raw = request.auth_query_param;
    const std::string encoded =
    vayu::core::encode_query_component (raw, vayu::core::QueryPart::Key);
    const auto split = split_url_query (request.url);
    if (!split.query) {
        return std::nullopt;
    }
    const auto& pairs = *split.query;
    const auto found  = std::find_if (
    pairs.rbegin (), pairs.rend (), [&] (const vayu::http::UrlQueryParam& pair) {
        return pair.key == raw || pair.key == encoded;
    });
    if (found == pairs.rend ()) {
        return std::nullopt;
    }
    return *found;
}

/// @p url without the last pair equal to @p pair, the rest of it kept; false
/// when it holds none.
bool remove_last_query_pair (std::string& url, const vayu::http::UrlQueryParam& pair) {
    auto split = split_url_query (url);
    if (!split.query) {
        return false;
    }
    auto& pairs      = *split.query;
    const auto found = std::find_if (
    pairs.rbegin (), pairs.rend (), [&] (const vayu::http::UrlQueryParam& p) {
        return p.key == pair.key && p.value == pair.value;
    });
    if (found == pairs.rend ()) {
        return false;
    }
    pairs.erase (std::next (found).base ());
    const std::string query = vayu::http::compose_query (pairs);
    url = split.head + (query.empty () ? "" : "?" + query) + split.fragment;
    return true;
}

/**
 * Takes off @p staged the credential the engine applied to @p before, so the
 * script's own auth replaces it rather than landing beside it: only what the
 * engine wrote (`Request::auth_header` the header, `auth_query_param` the query
 * pair), and only while the script left it as read. A value the script wrote
 * under either is the script's, and a header the engine did not write (typed on
 * the request, or skipped by `apply_auth` because one was there) is untouched,
 * so it wins over the assigned auth as over the request's own (#2475).
 */
void drop_engine_credential (const Request& before, const Headers& written, Request& staged) {
    if (!before.auth_header.empty ()) {
        const Headers shown = before.headers.folded ();
        const auto was      = shown.find (before.auth_header);
        const auto now      = written.find (before.auth_header);
        if (was != shown.end () && now != written.end () && now->second == was->second) {
            staged.headers.erase (before.auth_header);
            std::erase_if (staged.secret_header_names, [&] (const std::string& name) {
                return CaseInsensitiveLess::equal (name, before.auth_header);
            });
        }
    }
    if (const auto pair = engine_query_credential (before)) {
        if (remove_last_query_pair (staged.url, *pair)) {
            staged.auth_query_param.clear ();
        }
    }
    // It described the engine's auth, which no longer applies.
    staged.auth_notice.clear ();
}

/**
 * A script-assigned `pm.request.auth`, composed onto @p staged in place of the
 * engine's: read by `pm.sendRequest`'s reader, resolved against the scopes as
 * the script left them, applied by `apply_auth`. Undefined or null (never
 * assigned, deleted, or `authorizeUsing (null)`) leaves the request's own auth,
 * what an absent auth means in Postman.
 */
std::optional<std::string> apply_script_auth (JSContext* ctx,
JSValueConst js_auth,
const Request& before,
const Headers& written,
Request& staged) {
    if (JS_IsUndefined (js_auth) || JS_IsNull (js_auth)) {
        return std::nullopt;
    }
    vayu::http::Auth auth = vayu::http::NoAuth{};
    if (auto reason = read_script_auth (ctx, js_auth, PM_REQUEST_AUTH, auth)) {
        return reason;
    }
    if (auto reason = resolve_script_auth (ctx, auth, PM_REQUEST_AUTH.label)) {
        return reason;
    }
    drop_engine_credential (before, written, staged);
    // `db` is null because no type the reader accepts needs one.
    if (const auto applied = vayu::http::apply_auth (staged, auth, nullptr);
    !applied.ok) {
        return "pm.request.auth could not be applied: " + applied.message;
    }
    staged.auth_from_script = true;
    return std::nullopt;
}

} // namespace

/**
 * Applies the script's `pm.request` back onto the request to be sent. The JS
 * object is authoritative, not a diff: its header set at return is the wire set
 * (a name left as read keeps its repeated lines, `apply_script_headers`), so
 * `delete pm.request.headers['Authorization']` removes an engine-applied header
 * and dropping `pm.request.body` drops the body; the one rule true for a script
 * that replaces `pm.request` wholesale.
 *
 * Precedence over engine-applied auth falls out of the ordering:
 * `build_request` resolves auth before the script runs, so the script sees the
 * real outgoing set and writes later. Auth waiting on the script
 * (`apply_late_auth`: a credential naming a variable, or any `{{name}}` of a
 * request a pre-request script runs before, #2521) is applied after it, so the
 * script's set lacks that header and a header it sets still wins. An assigned
 * `pm.request.auth` replaces the engine's credential and stops the deferred one
 * (`apply_script_auth`).
 *
 * All-or-nothing: every field is staged and validated before anything commits,
 * so a good header and a bad method send neither.
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

    // Either shape: the Url object `pm.request.url` normally holds, or the
    // plain string a script that replaced `pm.request` with a literal leaves;
    // both are the URL, neither a diff.
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
    // `pm.request.method = 'post'` means POST: normalising a value plainly
    // meant, not accepting a wrong one; an unrecognised verb still fails
    // loudly.
    method_text = vayu::utils::ascii_upper (method_text);
    if (auto parsed = parse_method (method_text)) {
        staged.method = *parsed;
    } else {
        return "pm.request.method must be one of GET, POST, PUT, DELETE, "
               "PATCH, HEAD, OPTIONS (got \"" +
        js_to_string (ctx, js_method.get ()) + "\")";
    }

    ScopedValue js_headers (ctx, JS_GetPropertyStr (ctx, js_request.get (), "headers"));
    Headers written;
    if (auto reason = read_header_object (ctx, js_headers.get (), "pm.request.headers",
        /*suggest_delete=*/true, written)) {
        return reason;
    }
    staged.headers = apply_script_headers (request.headers, written);

    ScopedValue js_body (ctx, JS_GetPropertyStr (ctx, js_request.get (), "body"));
    if (JS_IsUndefined (js_body.get ()) || JS_IsNull (js_body.get ())) {
        staged.body = Body{};
    } else if (auto staged_text =
               script_body_text (ctx, js_body.get (), staged.body.mode);
    !staged_text) {
        return std::move (staged_text.error ());
    } else {
        // Any shape (the RequestBody object, a plain string, a Postman
        // description) is the body as a string, the same from here on.
        std::string body_text = std::move (*staged_text);
        // Every other member is authoritative, but `body` cannot be for a form
        // mode: its string is a view of the fields, and applying it back would
        // rewrite the field list of every request whose script merely read the
        // body (dropping the disabled rows the view omits) and refuse every
        // form-data request. So an unchanged string means untouched, and the
        // body stays as it stands.
        const bool untouched = staged.body.mode != BodyMode::None &&
        body_text == script_body_view (staged.body);
        if (untouched) {
            // Nothing to apply: the wire outcome is identical for a content
            // mode, and for a form mode this keeps a read-only script from
            // rewriting the body.
        } else if (staged.body.mode == BodyMode::FormData) {
            // One of the two modes whose view is not the wire (binary is the
            // other), so it cannot take a string back, and text parts would be
            // the wrong shape once a part can be a file (#393): an appended
            // field would drop the upload. Refused rather than applied to a
            // body the transfer ignores.
            return std::string (
            "pm.request.body cannot be assigned on a form-data request: its "
            "parts are multipart, not a string - edit the request's form "
            "fields, or delete pm.request.body to send no body");
        } else if (staged.body.mode == BodyMode::Binary) {
            // The body is a file a script never chooses: the view names it, and
            // a string written back would send nothing, as this mode sends
            // `file`, not `content`.
            return std::string (
            "pm.request.body cannot be assigned on a binary request: its body "
            "is a file, not a string - choose the file in the request, or "
            "delete pm.request.body to send no body");
        } else if (staged.body.mode == BodyMode::Form) {
            // The view is the wire body here, so it parses straight back into
            // the fields; `content` is cleared to keep the invariant that
            // exactly one carries a body.
            staged.body.fields = vayu::http::parse_urlencoded (body_text);
            staged.body.content.clear ();
        } else {
            staged.body.content = std::move (body_text);
            if (staged.body.mode == BodyMode::None) {
                // A body on a bodyless request: Text means "this string, as
                // written", sent as `text/plain` unless the script set a
                // Content-Type (#2464).
                staged.body.mode = BodyMode::Text;
            }
        }
    }

    // Last, because it writes into the URL and headers staged above.
    ScopedValue js_auth (ctx, JS_GetPropertyStr (ctx, js_request.get (), "auth"));
    if (auto reason = apply_script_auth (ctx, js_auth.get (), request, written, staged)) {
        return reason;
    }

    request = std::move (staged);
    return std::nullopt;
}

} // namespace vayu::runtime::pm_detail
