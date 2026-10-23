/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_request_url.cpp
 * @brief `pm.request`, its `Url` object, `pm.info` and the pre-request write-back.
 */

#include "pm_internal.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
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
 * @brief What `pm.request.url` is, behind the members a script reads.
 *
 * `pm.request.url` was a string primitive; issue #991 records the owner
 * decision that Postman compatibility wins over keeping that shape, so it is
 * now the `Url` object a lifted Postman script expects - `url.query.get(...)`,
 * `url.getPath()`, `url.host` and the rest. The members are built in
 * `build_request_url_members` further down; what lives up here is the
 * *identity*, which three surfaces read without them: the `pm.request`
 * write-back, the jar methods and `pm.sendRequest` all had "is this a string?"
 * as their entire type check, and each of them is documented as taking
 * `pm.request.url`.
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

} // namespace

/**
 * Which of the request's header records a script shows.
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

/// Encoded here, as the send would write it (issue #1773): the rows hold wire
/// bytes, so `all` and `getQueryString()` read what goes out. Postman adds a
/// row and `normalizeParam` writes it, so the per-row rule applies. A request
/// that sends its URL as typed keeps the row as typed.
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
    define ("addQueryParams",
    JS_NewCFunction (ctx, js_url_add_query_params, "addQueryParams", 1));
    define ("removeQueryParams",
    JS_NewCFunction (ctx, js_url_remove_query_params, "removeQueryParams", 1));
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
 *   unresolved, or a mistyped one), or that nests deeper than
 *   `constants::request_body::MAX_JSON_DEPTH` levels: **undefined**.
 *   `graphql_wire_body` passes that through untouched rather than guessing at
 *   it, and any pair invented here would be the guess it refuses. `.raw` still
 *   carries the string, so the body is described as unreadable rather than
 *   hidden.
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
    // The body is a string field the request-body depth bound (#2417) never
    // looks inside, and the `dump` below recurses (#2672). An envelope nested
    // past the bound is unreadable, the answer `graphql_get_parameters` gives
    // it too, so the two readers of one body still agree.
    if (vayu::json::exceeds_depth (document, vayu::core::constants::request_body::MAX_JSON_DEPTH)) {
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

} // namespace

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
 * The script's single-valued header object applied back onto the request's
 * lines (issue #2466). A name whose value the script left as it read it keeps
 * every line it had, in place and in its own spelling, so a repeated header
 * survives a script that never touched it - the same "unchanged means
 * untouched" rule the body follows below. A changed name becomes one line
 * where its first line was; a removed name loses every line; a new one is
 * appended.
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

} // namespace

/**
 * @brief Apply the script's `pm.request` back onto the request that will be sent.
 *
 * The JS object is authoritative, not a diff: the header set it holds when the
 * script returns is the header set that goes on the wire (a name it left as
 * it read it keeps its repeated lines, `apply_script_headers`), so
 * `delete pm.request.headers['Authorization']` removes an engine-applied
 * header, and dropping `pm.request.body` drops the body. That is the only rule
 * that stays true for a script which replaces `pm.request` wholesale.
 *
 * Precedence over engine-applied auth falls out of the ordering rather than
 * being a special case: `build_request` resolves auth into the request before
 * the script runs, so the script sees the real outgoing set and its writes are
 * simply later. Auth that waits on the script (`apply_late_auth`: a credential
 * naming a variable, or any `{{name}}` of a request a pre-request script runs
 * before, #2521) is applied after it, so the script's set lacks that header and
 * a header the script sets still wins.
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
    Headers written;
    if (auto reason = read_header_object (ctx, js_headers.get (), "pm.request.headers",
        /*suggest_delete=*/true, written)) {
        return reason;
    }
    staged.headers = apply_script_headers (request.headers, written);

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
                // "this string, as written". The send derives `text/plain` for
                // it unless the script set a Content-Type (issue #2464).
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

} // namespace vayu::runtime::pm_detail
