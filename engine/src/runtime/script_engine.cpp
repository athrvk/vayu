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
 * `pm/pm_internal.hpp`; what stays here is the console, base64, the timers
 * and `pm.crypto`, the `pm` composer and the engine itself (issue #2092).
 *
 * Nothing here is linted: `engine/src/runtime/.clang-tidy` turns every check off
 * for this directory, with the reason. There used to be a file-wide
 * NOLINTBEGIN/NOLINTEND pair saying the same thing a second way (#885) - two
 * mechanisms for one exemption, the weaker of which silently stops covering the
 * file the moment a function is moved out of it.
 */

#include "vayu/runtime/script_engine.hpp"

#include <array>
#include <chrono>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

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

// ============================================================================
// Base64 globals and pm.crypto
// ============================================================================
//
// Why this is synchronous, and why it is not called `crypto.subtle`.
//
// Web Crypto's SubtleCrypto returns Promises and covers algorithms this sandbox
// does not implement. Wearing the Web Crypto name while behaving differently is
// the exact trap the sandbox-surface tests exist to catch, so the hashing
// surface takes a name of its own, `pm.crypto`, and is honestly synchronous.
// `btoa` / `atob` keep their standard names because they are synchronous on
// the web too, and they keep their standard Latin-1 semantics with them.

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

// Turns a digest into whatever the caller asked for. 'bytes' exists so a digest
// can be fed back in as a key: multi-round key derivation (AWS SigV4 signs with
// the raw digest of the previous round) is impossible when the only outputs are
// text.
JSValue encode_digest (JSContext* ctx,
const std::array<uint8_t, 32>& digest,
const std::string& encoding) {
    const std::string_view raw = vayu::utils::byte_view (digest);

    if (encoding == "bytes") {
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

    if (encoding != "hex" && encoding != "base64" && encoding != "base64url") {
        return JS_ThrowTypeError (ctx,
        "unknown digest encoding '%s' - expected 'hex', 'base64', "
        "'base64url' or 'bytes'",
        encoding.c_str ());
    }

    // Initialised, not assigned in branches: GCC 13 at -O3 reads the move-assign
    // into a default-constructed SSO string as an out-of-bounds copy
    // (-Warray-bounds, an error under VAYU_WERROR).
    const std::string out = encoding == "hex" ? vayu::utils::hex_encode (raw) :
    encoding == "base64" ? vayu::utils::base64_encode (raw) :
                           vayu::utils::base64url_encode (raw);

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

// ============================================================================
// Timers: setTimeout, setInterval, clearTimeout, clearInterval (#2577)
// ============================================================================
//
// Callbacks run on `TimerQueue`'s virtual clock, drained before the script
// ends (`drain_async_work`), so a delay orders callbacks and never blocks the
// thread: an inline load-run script runs where blocking is not allowed, and a
// Postman script's `setTimeout` used as a sleep would otherwise spend the
// script's own deadline doing nothing.

enum class TimerKind : std::uint8_t { Once, Repeating };

// Node's rule (`lib/internal/timers.js`), the runtime Postman scripts are
// written against: a delay that is not a number from 1 to TIMEOUT_MAX is 1.
constexpr double TIMER_DELAY_MAX_MS = 2147483647.0;

JSValue
js_set_timer (JSContext* ctx, JSValueConst /*this_val*/, int argc, JSValueConst* argv, int magic) {
    const char* name =
    static_cast<TimerKind> (magic) == TimerKind::Repeating ? "setInterval" : "setTimeout";
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "%s requires a function as its first argument", name);
    }
    double delay_ms = 1;
    if (argc >= 2 && JS_ToFloat64 (ctx, &delay_ms, argv[1]) < 0) {
        return JS_EXCEPTION;
    }
    if (!(delay_ms >= 1 && delay_ms <= TIMER_DELAY_MAX_MS)) {
        delay_ms = 1;
    }

    auto& queue = get_context_data (ctx)->timers;
    constexpr size_t cap = vayu::core::constants::script_engine::MAX_PENDING_TIMERS;
    if (queue.size () >= cap) {
        return JS_ThrowRangeError (ctx,
        "%s: %zu timers are already pending, the most one script may hold", name, cap);
    }

    ScriptTimer timer;
    timer.callback = JS_DupValue (ctx, argv[0]);
    for (int i = 2; i < argc; ++i) {
        timer.args.push_back (JS_DupValue (ctx, argv[i]));
    }
    if (static_cast<TimerKind> (magic) == TimerKind::Repeating) {
        timer.interval_ms = delay_ms;
    }
    return JS_NewInt64 (ctx, queue.schedule (std::move (timer), delay_ms));
}

// clearTimeout and clearInterval share one id space, as in Node and on the web.
JSValue js_clear_timer (JSContext* ctx, JSValueConst /*this_val*/, int argc, JSValueConst* argv) {
    int64_t id = 0;
    if (argc >= 1 && JS_IsNumber (argv[0]) && JS_ToInt64 (ctx, &id, argv[0]) == 0) {
        get_context_data (ctx)->timers.cancel (ctx, id);
    }
    return JS_UNDEFINED;
}

void setup_timers (JSContext* ctx) {
    JSValue global = JS_GetGlobalObject (ctx);
    JS_SetPropertyStr (ctx, global, "setTimeout",
    JS_NewCFunctionMagic (ctx, js_set_timer, "setTimeout", 2,
    JS_CFUNC_generic_magic, static_cast<int> (TimerKind::Once)));
    JS_SetPropertyStr (ctx, global, "setInterval",
    JS_NewCFunctionMagic (ctx, js_set_timer, "setInterval", 2,
    JS_CFUNC_generic_magic, static_cast<int> (TimerKind::Repeating)));
    JS_SetPropertyStr (ctx, global, "clearTimeout",
    JS_NewCFunction (ctx, js_clear_timer, "clearTimeout", 1));
    JS_SetPropertyStr (ctx, global, "clearInterval",
    JS_NewCFunction (ctx, js_clear_timer, "clearInterval", 1));
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

void setup_pm_object (JSContext* ctx) {
    JSValue global = JS_GetGlobalObject (ctx);
    JSValue pm     = JS_NewObject (ctx);

    // A class registered with JS_NewClass has no prototype until one is set, so
    // without this the pm.response.to.* and pm.expect(...) objects would answer
    // nothing but their own members - toString, hasOwnProperty and friends would
    // reach the unknown-member hook and throw. Both chains and an expectation's
    // matchers are armed, so all three need it; `JS_SetClassProto` takes
    // ownership of the value it is given, so the first two calls get a
    // reference of their own.
    JSValue plain        = JS_NewObject (ctx);
    JSValue object_proto = JS_GetPrototype (ctx, plain);
    JS_FreeValue (ctx, plain);
    JS_SetClassProto (ctx, expect_class_id, JS_DupValue (ctx, object_proto));
    JS_SetClassProto (ctx, expect_member_class_id, JS_DupValue (ctx, object_proto));
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

    // pm.visualizer - Postman's calls, accepted and not rendered (#2577).
    setup_pm_visualizer (ctx, pm);

    // pm.sendRequest - always bound, even when the capability is off, so a
    // script that calls it gets a sentence explaining why rather than
    // "not a function".
    JS_SetPropertyStr (ctx, pm, "sendRequest",
    JS_NewCFunction (ctx, js_pm_send_request, "sendRequest", 2));

    JS_SetPropertyStr (ctx, global, "pm", pm);
    JS_FreeValue (ctx, global);
}

// expect_class_id / expect_member_class_id / response_chain_class_id /
// request_url_class_id / request_body_class_id are process-wide: every native callback looks one up
// by name (JS_GetOpaque (ctx, ..., xxx_class_id)) rather than through the
// JSRuntime that happens to own its JSContext, since each OS thread owns a
// wholly separate JSRuntime (QuickJS's own is not thread-safe) but the five
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

// Reads a hash input: a string contributes its UTF-8 bytes, a Uint8Array its
// bytes as they are. Anything else throws rather than being stringified -
// hashing the text "[object Object]" would be a silent wrong answer, and the
// digest gives the author no clue that it happened.
// Built from JS_GetTypedArrayBuffer + JS_GetArrayBuffer rather than
// JS_GetUint8Array because the first reports the element size, which the
// byte-order refusal below needs.
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

void free_script_timer (JSContext* ctx, ScriptTimer& timer) {
    JS_FreeValue (ctx, timer.callback);
    timer.callback = JS_UNDEFINED;
    for (JSValue arg : timer.args) {
        JS_FreeValue (ctx, arg);
    }
    timer.args.clear ();
}

int64_t TimerQueue::schedule (ScriptTimer timer, double delay_ms) {
    const int64_t id = next_id_++;
    place (id, Entry{ std::move (timer), {} }, now_ms_ + delay_ms);
    return id;
}

void TimerQueue::place (int64_t id, Entry entry, double due_ms) {
    entry.slot = { due_ms, next_seq_++ };
    order_.emplace (entry.slot, id);
    timers_.insert_or_assign (id, std::move (entry));
}

void TimerQueue::cancel (JSContext* ctx, int64_t id) {
    auto found = timers_.find (id);
    if (found == timers_.end ()) {
        return;
    }
    order_.erase (found->second.slot);
    free_script_timer (ctx, found->second.timer);
    timers_.erase (found);
}

ScriptTimer TimerQueue::take_next (JSContext* ctx) {
    if (order_.empty ()) {
        return {};
    }
    const auto [slot, id] = *order_.begin ();
    order_.erase (order_.begin ());
    now_ms_ = slot.first;

    auto found = timers_.find (id);
    if (found == timers_.end ()) {
        return {};
    }
    Entry entry = std::move (found->second);
    timers_.erase (found);
    if (!entry.timer.interval_ms) {
        return std::move (entry.timer);
    }

    ScriptTimer call;
    call.callback = JS_DupValue (ctx, entry.timer.callback);
    for (JSValue arg : entry.timer.args) {
        call.args.push_back (JS_DupValue (ctx, arg));
    }
    const double period = *entry.timer.interval_ms;
    place (id, std::move (entry), now_ms_ + period);
    return call;
}

void TimerQueue::clear (JSContext* ctx) {
    for (auto& queued : timers_) {
        free_script_timer (ctx, queued.second.timer);
    }
    timers_.clear ();
    order_.clear ();
}

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

namespace {

/// Takes @p promise off the unhandled list, freeing the tracker's reference.
void forget_rejection (JSContext* ctx, RuntimeState& state, JSValueConst promise) {
    auto& rejections = state.unhandled_rejections;
    for (auto it = rejections.begin (); it != rejections.end (); ++it) {
        if (JS_IsStrictEqual (ctx, *it, promise)) {
            JS_FreeValue (ctx, *it);
            rejections.erase (it);
            return;
        }
    }
}

} // namespace

// QuickJS reports a promise rejected with no handler (`is_handled` false), and
// reports it again if a handler is attached later (true). What is still listed
// once the job queue has drained is a rejection the script never observed.
extern "C" void script_rejection_tracker (JSContext* ctx,
JSValueConst promise,
JSValueConst /*reason*/,
bool is_handled,
void* opaque) {
    auto* state = static_cast<RuntimeState*> (opaque);
    if (!state)
        return;
    if (!is_handled) {
        state->unhandled_rejections.push_back (JS_DupValue (ctx, promise));
        return;
    }
    forget_rejection (ctx, *state, promise);
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
        JS_SetHostPromiseRejectionTracker (rt, &script_rejection_tracker, rt_state);

        // The five ids below are process-wide (see class_id_registration_mutex's
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

            // Register the class of an expectation's matchers and chainable
            // methods, callable objects whose hook refuses an unknown member.
            if (expect_member_class_id == 0) {
                JS_NewClassID (rt, &expect_member_class_id);
            }
            JS_NewClass (rt, expect_member_class_id, &expect_member_class);

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
    /// (`console`, `btoa`/`atob`, the timers, `require` and the library
    /// globals, `pm`) and nothing else; `execute` binds the legacy globals
    /// (`postman`, `tests`, ...) once the execution's data is in place. Paid
    /// for by every script, so nothing here evaluates a library (#2578).
    JSContext* build_context (JSRuntime* rt) {
        JSContext* ctx = JS_NewContext (rt);
        if (!ctx) {
            return nullptr;
        }
        if (config.enable_console) {
            setup_console (ctx);
        }
        setup_base64_globals (ctx);
        setup_timers (ctx);
        setup_require_shelf (ctx);
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
    /// later script. `drain_async_work` empties the queue, so a job is left
    /// only when the drain stopped at the deadline or the job cap, and that
    /// job must never run: it is user code past its budget, against a context
    /// whose `ContextData` is gone. `JS_FreeRuntime` drops it unrun, which
    /// releases the context. Every value the execution itself held must be
    /// freed before this call (`release_held_references`), for the same
    /// pinning reason. A timer left queued is one of those values rather than
    /// a reason to discard the runtime: the queue is the engine's, so freeing
    /// it drops the timer unrun.
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

    [[nodiscard]] std::string timeout_message () const {
        return "Script execution timed out after " +
        std::to_string (config.timeout_ms) + "ms";
    }

    /// What the exception pending on @p ctx says, taken off the context.
    [[nodiscard]] std::string take_exception_message (JSContext* ctx) const {
        JSValue exc = JS_GetException (ctx);
        // Whether the deadline stopped this script is the interrupt
        // handler's to answer, not the clock's - the same question #1056
        // settled one layer down. An error that merely *lands* past the
        // deadline is still that error: a script's own throw at the buzzer,
        // and `pm.sendRequest` refusing a spent budget from a blocking C
        // function the handler never gets to interrupt. Comparing the clock
        // here replaced the sentence naming the fault with a timeout line
        // the user could not act on.
        std::string message =
        script_deadline_expired (ctx) ? timeout_message () : js_to_string (ctx, exc);
        JS_FreeValue (ctx, exc);
        return message;
    }

    /// Why the drain must stop before running one more job or timer callback,
    /// or nullopt while it may go on. The deadline is checked here as well as
    /// by the interrupt handler inside a callback, because the handler polls
    /// only every few thousand bytecode operations and a native job polls not
    /// at all: without the check, a script the deadline already stopped would
    /// still run a short job. With no deadline the cap bounds the drain.
    [[nodiscard]] std::optional<std::string>
    async_budget_spent (const RuntimeState& state, size_t steps_run) const {
        constexpr size_t cap =
        vayu::core::constants::script_engine::MAX_ASYNC_JOBS_WITHOUT_TIMEOUT;
        if (state.enabled && std::chrono::steady_clock::now () > state.deadline) {
            return timeout_message ();
        }
        if (!state.enabled && steps_run == cap) {
            // Built in place: returning the concatenation by value trips a
            // GCC 13 -Warray-bounds false positive on the optional's move.
            std::optional<std::string> message;
            message.emplace ("Script stopped after running ");
            message->append (std::to_string (cap));
            message->append (
            " promise jobs and timer callbacks: with no script timeout "
            "(scriptTimeout 0) that is the limit on asynchronous work, and the "
            "rest were not run");
            return message;
        }
        return std::nullopt;
    }

    /// Runs every queued promise job, so `.then` callbacks and the code after
    /// an `await` run inside the execution (#2531). @p steps_run counts each
    /// job against the budget the timers share.
    [[nodiscard]] std::optional<std::string>
    drain_promise_jobs (JSRuntime* rt, const RuntimeState& state, size_t& steps_run) const {
        while (JS_IsJobPending (rt)) {
            if (auto stop = async_budget_spent (state, steps_run)) {
                return stop;
            }
            JSContext* job_ctx = nullptr;
            ++steps_run;
            if (JS_ExecutePendingJob (rt, &job_ctx) < 0) {
                return take_exception_message (job_ctx);
            }
        }
        return std::nullopt;
    }

    /// Calls the timer due first. A callback's throw is the script's error
    /// and the queue drains on, as an event loop would, which is the rule a
    /// throw in the script body already follows.
    void fire_next_timer (JSContext* js_ctx, ContextData& data, ScriptResult& result) const {
        ScriptTimer timer = data.timers.take_next (js_ctx);
        JSValue returned  = JS_Call (js_ctx, timer.callback, JS_UNDEFINED,
         static_cast<int> (timer.args.size ()), timer.args.data ());
        if (JS_IsException (returned)) {
            record_script_error (result, take_exception_message (js_ctx));
        }
        JS_FreeValue (js_ctx, returned);
        free_script_timer (js_ctx, timer);
    }

    /// Reports the script body's throw as the throw itself, the message a
    /// synchronous script has always reported, rather than as an unhandled
    /// rejection of the wrapper's promise.
    static void record_body_rejection (JSContext* js_ctx,
    RuntimeState& state,
    ContextData& data,
    ScriptResult& result) {
        if (JS_PromiseState (js_ctx, data.script_body) != JS_PROMISE_REJECTED) {
            return;
        }
        forget_rejection (js_ctx, state, data.script_body);
        JSValue reason = JS_PromiseResult (js_ctx, data.script_body);
        record_script_error (result, js_to_string (js_ctx, reason));
        JS_FreeValue (js_ctx, reason);
        JS_FreeValue (js_ctx, data.script_body);
        data.script_body = JS_UNDEFINED;
    }

    /// Runs what the script left to run later: the promise jobs, then the
    /// timer due first, then the jobs that callback queued, until both queues
    /// are empty (#2531, #2577).
    ///
    /// The body's rejection is read after every round of jobs, the only place
    /// it can have happened since the last read, so its throw is ordered
    /// against a timer callback's as the two happened.
    ///
    /// @return why the drain stopped with work still queued, or nullopt once
    ///         both queues are empty.
    [[nodiscard]] std::optional<std::string> drain_async_work (JSRuntime* rt,
    JSContext* js_ctx,
    RuntimeState& state,
    ContextData& data,
    ScriptResult& result) const {
        size_t steps_run = 0;
        while (true) {
            auto stop = drain_promise_jobs (rt, state, steps_run);
            record_body_rejection (js_ctx, state, data, result);
            if (stop) {
                return stop;
            }
            if (data.timers.empty ()) {
                return std::nullopt;
            }
            if (auto spent = async_budget_spent (state, steps_run)) {
                return spent;
            }
            ++steps_run;
            fire_next_timer (js_ctx, data, result);
        }
    }

    /// The first promise the script left unobserved once the queue drained:
    /// a rejection nothing handled, then a body or a `pm.test` promise that
    /// never settled. nullopt when there is none.
    static std::optional<std::string> unobserved_promise_error (JSContext* js_ctx,
    const RuntimeState& state,
    const ContextData& data) {
        if (!state.unhandled_rejections.empty ()) {
            return unhandled_rejection_message (js_ctx, state.unhandled_rejections, data);
        }
        if (JS_PromiseState (js_ctx, data.script_body) == JS_PROMISE_PENDING) {
            return "The script did not finish: it was still awaiting a promise "
                   "that never settled";
        }
        for (const auto& [promise, test_name] : data.async_tests) {
            if (JS_PromiseState (js_ctx, promise) == JS_PROMISE_PENDING) {
                return "A promise did not settle before the script ended "
                       "(returned by test \"" +
                test_name + "\")";
            }
        }
        return std::nullopt;
    }

    static std::string unhandled_rejection_message (JSContext* js_ctx,
    const std::vector<JSValue>& rejections,
    const ContextData& data) {
        JSValueConst first  = rejections.front ();
        std::string message = "Unhandled promise rejection";
        for (const auto& [promise, test_name] : data.async_tests) {
            if (JS_IsStrictEqual (js_ctx, promise, first)) {
                message += " in test \"" + test_name + "\"";
                break;
            }
        }
        // Read before the reason is rendered: a reason's own `toString` is
        // script code, and can settle or handle more promises.
        const size_t others = rejections.size () - 1;
        JSValue reason      = JS_PromiseResult (js_ctx, first);
        message += ": " + js_to_string (js_ctx, reason);
        JS_FreeValue (js_ctx, reason);
        if (others > 0) {
            message += " (and " + std::to_string (others) + " more unhandled " +
            (others == 1 ? "rejection" : "rejections") + ")";
        }
        return message;
    }

    /// Frees every promise and timer the execution held a reference to, which
    /// `release_context` needs first.
    static void
    release_held_references (JSContext* js_ctx, RuntimeState& state, ContextData& data) {
        for (JSValue promise : state.unhandled_rejections) {
            JS_FreeValue (js_ctx, promise);
        }
        state.unhandled_rejections.clear ();
        JS_FreeValue (js_ctx, data.script_body);
        data.script_body = JS_UNDEFINED;
        JS_FreeValue (js_ctx, data.legacy_tests);
        data.legacy_tests = JS_UNDEFINED;
        for (auto& entry : data.async_tests) {
            JS_FreeValue (js_ctx, entry.first);
        }
        data.async_tests.clear ();
        data.timers.clear (js_ctx);
        release_shelf_modules (js_ctx, data);
    }

    /// The first error an execution meets is the one it reports.
    static void record_script_error (ScriptResult& result, std::string message) {
        result.success = false;
        if (result.error_message.empty ()) {
            result.error_message = std::move (message);
        }
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
        // acquire_context sets the opaque on every runtime it hands out.
        auto& rt_state = *static_cast<RuntimeState*> (JS_GetRuntimeOpaque (rt));
        rt_state.enabled     = config.timeout_ms != 0;
        rt_state.interrupted = false;
        if (rt_state.enabled) {
            rt_state.deadline = std::chrono::steady_clock::now () +
            std::chrono::milliseconds (config.timeout_ms);
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
        // See ScriptContext::local for why an unbound one is not left null.
        ctx_data.local = ctx.local != nullptr ? ctx.local : &ctx_data.script_local;
        JS_SetContextOpaque (js_ctx, &ctx_data);

        // Refresh pm.request, pm.response, pm.info and pm.iterationData with
        // new data, then bind Postman's legacy globals over them: the response
        // ones exist only where there is a response.
        JSValue global = JS_GetGlobalObject (js_ctx);
        JSValue pm     = JS_GetPropertyStr (js_ctx, global, "pm");
        if (!JS_IsUndefined (pm)) {
            setup_pm_response (js_ctx, pm);
            setup_pm_request (js_ctx, pm);
            setup_pm_info (js_ctx, pm);
            setup_pm_iteration_data (js_ctx, pm);
            setup_postman_legacy (js_ctx, global, pm);
        }
        JS_FreeValue (js_ctx, pm);
        JS_FreeValue (js_ctx, global);

        // A function body, so a top-level `return` works, and an async one, so
        // a top-level `await` does, as Postman wraps every script (#2577). The
        // prefix adds no line, so a line number in a stack is the script's own.
        // JS_EVAL_FLAG_ASYNC is not the same: it evaluates global code, where
        // `return` is a syntax error.
        const std::string wrapped_script = "(async function() { " + script + " \n})()";

        JSValue eval_result = JS_Eval (js_ctx, wrapped_script.c_str (),
        wrapped_script.size (), "<script>", JS_EVAL_TYPE_GLOBAL);

        // A syntax error, or the deadline: an interrupt is uncatchable, so it
        // leaves the call as an exception rather than rejecting the promise.
        result.success = true;
        if (JS_IsException (eval_result)) {
            record_script_error (result, take_exception_message (js_ctx));
        } else {
            ctx_data.script_body = eval_result;
        }

        // Drained even after a throw, as Postman's event loop would: a job or
        // timer the script queued before throwing still runs, and the throw
        // stays the reported error. A script the deadline already stopped runs
        // no job.
        auto async_error = drain_async_work (rt, js_ctx, rt_state, ctx_data, result);
        if (!async_error) {
            async_error = unobserved_promise_error (js_ctx, rt_state, ctx_data);
        }
        if (async_error) {
            record_script_error (result, std::move (*async_error));
        }
        // After the pm.test rows, as Postman appends the legacy ones, and even
        // after a throw: what the script assigned before it threw was assigned.
        record_legacy_tests (js_ctx, ctx_data);

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
        // what an instruction from a script that then failed is worth. The
        // scenario runner ignores it for an errored step (issue #2526).
        result.control = std::move (ctx_data.control);

        // Check if any tests failed
        for (const auto& test : result.tests) {
            if (!test.passed) {
                result.success = false;
                break;
            }
        }

        // Last before the release: the write-back above reads script objects
        // too, and a promise it caused to reject is tracked like any other.
        release_held_references (js_ctx, rt_state, ctx_data);
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

size_t ScriptEngine::shelf_library_loads () {
    return pm_detail::shelf_library_loads ();
}

size_t ScriptEngine::idle_runtime_count () const {
    std::lock_guard<std::mutex> lock (impl_->pool_mutex);
    return impl_->context_pool.size ();
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

size_t ScriptEngine::shelf_library_loads () {
    return 0;
}

std::string ScriptEngine::version () {
    return "";
}

size_t ScriptEngine::idle_runtime_count () const {
    return 0;
}

#endif // VAYU_HAS_QUICKJS

} // namespace vayu::runtime
