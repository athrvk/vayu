/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_response.cpp
 * @brief `pm.response`, its header accessors and its `to` assertion chain.
 */

#include "pm_internal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <format>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include "vayu/http/status.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

// json() and text() read the body bound to the function at build time rather
// than the response hanging off the context, so `pm.response` and the response
// a pm.sendRequest callback receives are served by one implementation instead
// of two that can drift. Both are installed by `install_response_body_readers`.
JSValue js_response_json (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;

    size_t length    = 0;
    const char* body = JS_ToCStringLen (ctx, &length, func_data[0]);
    if (!body) {
        return JS_EXCEPTION;
    }
    JSValue json = JS_ParseJSON (ctx, body, length, "<response>");
    JS_FreeCString (ctx, body);
    if (JS_IsException (json)) {
        // Replaces QuickJS's parse error, which names an offset into a string
        // the script never sees.
        JS_FreeValue (ctx, JS_GetException (ctx));
        return JS_ThrowTypeError (ctx, "Response body is not valid JSON");
    }

    return json;
}

JSValue js_response_text (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic,
JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;

    return JS_DupValue (ctx, func_data[0]);
}

} // namespace

// Install json()/text() on @p response, bound to @p body.
void install_response_body_readers (JSContext* ctx, JSValue response, const std::string& body) {
    JSValue bound = JS_NewStringLen (ctx, body.data (), body.size ());

    JS_SetPropertyStr (ctx, response, "json",
    JS_NewCFunctionData (ctx, js_response_json, 0, 0, 1, &bound));
    JS_SetPropertyStr (ctx, response, "text",
    JS_NewCFunctionData (ctx, js_response_text, 0, 0, 1, &bound));

    JS_FreeValue (ctx, bound);
}

// ============================================================================
// pm.response.to.have Assertions (Postman-compatible)
// ============================================================================

// These are chai assertions in Postman exactly as `pm.expect` is, so their
// failures throw through `throw_assertion_failure` too - a report that named
// one form `AssertionError` and the other `TypeError` would be a distinction
// with nothing behind it. They carry no chai message argument (`status(200)`
// takes a status code, not a message), so they call the helper directly rather
// than through `throw_expect_failure`, which exists to apply that prefix.

// The reason phrase as `pm.response.reason()` answers it: what the status line
// carried when it carried one, and the registered phrase for the code when it
// did not - HTTP/2 has no reason phrase on the wire at all. One definition,
// because `to.have.status("OK")` and `reason()` are two readings of the same
// response and a script that compares them must not get two answers.
std::string response_reason_phrase (const Response& response) {
    if (!response.status_text.empty ()) {
        return response.status_text;
    }
    return vayu::http::status_text (response.status_code);
}

namespace {

// A body can be megabytes, so a failure message quotes a bounded prefix rather
// than the whole of it - and cuts on a UTF-8 boundary, because a message split
// mid-sequence reaches the report as replacement characters.
constexpr std::string::size_type kBodyExcerptBytes = 120;

std::string describe_body (const std::string& body) {
    if (body.size () <= kBodyExcerptBytes) {
        return "'" + body + "'";
    }
    std::string::size_type cut = kBodyExcerptBytes;
    while (cut > 0 && (static_cast<unsigned char> (body[cut]) & 0xC0) == 0x80) {
        --cut;
    }
    return "'" + body.substr (0, cut) + "...' (" + std::to_string (body.size ()) + " bytes)";
}

// A number as a message quotes it back. `std::format` gives the shortest
// spelling that round-trips (`200`, not `200.000000`; `200.5`, not
// `200.500000`), and the three values it spells in C are given JavaScript's
// names, because the script author is reading their own source back.
std::string describe_number (double value) {
    if (std::isnan (value)) {
        return "NaN";
    }
    if (std::isinf (value)) {
        return value > 0 ? "Infinity" : "-Infinity";
    }
    return std::format ("{}", value);
}

// `size()`'s two halves. `header` is the serialised block - "Name: Value\r\n"
// each - reconstructed from the parsed headers rather than measured off the
// wire, so it will not match a Content-Length-derived figure to the byte.
struct ResponseSizeBytes {
    size_t body   = 0;
    size_t header = 0;
};

ResponseSizeBytes response_size_bytes (const Response& response) {
    constexpr size_t separator_and_crlf = 4; // ": " + "\r\n"
    ResponseSizeBytes size;
    for (const auto& [key, value] : response.headers) {
        size.header += key.size () + value.size () + separator_and_crlf;
    }
    size.body = response.body.size ();
    return size;
}

// ----------------------------------------------------------------------------
// Polarity. `pm.response.to.not` is a second chain whose matchers are functions
// of their own, so the `not` is bound into each function rather than read off
// `this`: a matcher detached from `to.not.have` keeps the polarity of the
// chain it was read from instead of silently asserting the opposite.
// ----------------------------------------------------------------------------

// A response matcher's magic: a table row above the low bit, the chain's
// polarity in it.
constexpr int matcher_magic (size_t row, bool negated) {
    return static_cast<int> (row << 1U) | (negated ? 1 : 0);
}
constexpr bool magic_negated (int magic) {
    return (static_cast<unsigned> (magic) & 1U) != 0;
}
constexpr size_t magic_row (int magic) {
    return static_cast<size_t> (magic) >> 1U;
}

/**
 * chai's `this.assert (condition, message, negatedMessage)`, the shape of every
 * check chai-postman makes: under `not` the condition must be false.
 *
 * A matcher that checks two things checks them in chai-postman's order, each
 * negated on its own, so `to.not.have.header("X", "v")` fails whenever X is
 * present - Postman's verdict, which inverting the whole assertion would turn
 * into a pass for any other value.
 *
 * A message is a string, or a callable that builds one. A message quoting a
 * script value is the callable: `js_describe` runs the value's `toJSON`, which
 * a passing check has no reason to call.
 *
 * @return whether the check held; when it did not, the AssertionError is
 *         pending.
 */
template <typename Message> std::string message_text (const Message& message) {
    if constexpr (std::is_invocable_v<const Message&>) {
        return message ();
    } else {
        return std::string (message);
    }
}

template <typename Message, typename NegatedMessage>
bool check_holds (JSContext* ctx,
bool negated,
bool condition,
const Message& message,
const NegatedMessage& negated_message) {
    if (condition != negated) {
        return true;
    }
    throw_assertion_failure (
    ctx, negated ? message_text (negated_message) : message_text (message));
    return false;
}

JSValue check_result (bool held) {
    return held ? JS_UNDEFINED : JS_EXCEPTION;
}

// The body as `pm.response.json()` reads it, or `undefined` when it is not
// JSON - a value JSON.parse never produces, so it cannot be mistaken for a
// body. The parse error is cleared: each caller reports an unparsable body in
// its own words, and under `not` it is no failure at all.
JSValue parse_body_json (JSContext* ctx, const std::string& body) {
    JSValue json = JS_ParseJSON (ctx, body.c_str (), body.size (), "<response>");
    if (JS_IsException (json)) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return JS_UNDEFINED;
    }
    return json;
}

// A status code as the script wrote it. `JS_ToInt32` truncated toward zero, so
// `status(200.5)` compared as 200 and passed against a 200. No response can
// carry a fractional or non-finite code, so an assertion written that way is
// not a statement about the response at all; it is refused the way `body(5)`
// is rather than reported as a verdict, which would name the status the author
// got and leave the mistake in their own text unmentioned. nullopt with the
// exception pending.
std::optional<double>
read_status_code_arg (JSContext* ctx, JSValueConst value, const char* matcher) {
    double code = 0;
    if (JS_ToFloat64 (ctx, &code, value) < 0) {
        // The conversion's own error - a Symbol, a `valueOf` that throws - is
        // the script's, and QuickJS has already named it.
        return std::nullopt;
    }
    if (!std::isfinite (code) || std::trunc (code) != code) {
        JS_ThrowTypeError (ctx, "%s() expects an integer status code, got %s",
        matcher, describe_number (code).c_str ());
        return std::nullopt;
    }
    return code;
}

JSValue check_status_code (JSContext* ctx, bool negated, int actual, double expected) {
    return check_result (check_holds (ctx, negated, static_cast<double> (actual) == expected,
    "Expected status code " + describe_number (expected) + " but got " + std::to_string (actual),
    "Expected status code to not be " + std::to_string (actual)));
}

JSValue check_status_reason (JSContext* ctx,
bool negated,
const Response& response,
const std::string& expected) {
    const std::string actual = response_reason_phrase (response);
    return check_result (check_holds (ctx, negated, actual == expected,
    "Expected status reason '" + expected + "' but got '" + actual + "'",
    "Expected status reason to not be '" + actual + "'"));
}

const Response* require_response (JSContext* ctx) {
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        JS_ThrowInternalError (ctx, "No response available");
        return nullptr;
    }
    return data->response;
}

JSValue js_response_have_status (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "status() requires an expected status code");
    }
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }

    // Postman takes either form and decides by type, never by coercion:
    // chai-postman compares a string against `reason()` and a number against
    // the code. Coercing both through `JS_ToInt32` read "OK" as 0 - failing an
    // assertion Postman passes - and "200" as 200 - passing one Postman fails.
    if (JS_IsString (argv[0])) {
        return check_status_reason (
        ctx, magic_negated (magic), *response, js_to_string (ctx, argv[0]));
    }
    const auto expected = read_status_code_arg (ctx, argv[0], "status");
    if (!expected) {
        return JS_EXCEPTION;
    }
    return check_status_code (ctx, magic_negated (magic), response->status_code, *expected);
}

// chai-postman's `statusCode(code)` is `code === Number(code)`, so unlike
// `status` a numeric string is the code it spells.
JSValue js_response_have_status_code (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "statusCode() requires an expected status code");
    }
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const auto expected = read_status_code_arg (ctx, argv[0], "statusCode");
    if (!expected) {
        return JS_EXCEPTION;
    }
    return check_status_code (ctx, magic_negated (magic), response->status_code, *expected);
}

// chai-postman's `statusReason(reason)` compares `String(reason)`.
JSValue js_response_have_status_reason (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "statusReason() requires an expected reason phrase");
    }
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const char* expected = JS_ToCString (ctx, argv[0]);
    if (!expected) {
        return JS_EXCEPTION;
    }
    const std::string reason (expected);
    JS_FreeCString (ctx, expected);
    return check_status_reason (ctx, magic_negated (magic), *response, reason);
}

// `statusCodeClass(2)` - the code's hundreds digit. chai-postman compares with
// `===`, so a class written as a string matches nothing there; it is refused
// here instead, as a mistake in the script rather than a verdict.
JSValue js_response_have_status_code_class (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    double digit = 0;
    if (argc < 1 || !JS_IsNumber (argv[0]) || JS_ToFloat64 (ctx, &digit, argv[0]) < 0 ||
    !std::isfinite (digit) || std::trunc (digit) != digit) {
        return JS_ThrowTypeError (ctx,
        "statusCodeClass() expects a status class digit such as 2, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const int code                 = response->status_code;
    const std::string status_class = describe_number (digit) + "xx";
    return check_result (check_holds (ctx, magic_negated (magic), code / 100 == digit,
    "Expected response to have a " + status_class + " status code but got " + std::to_string (code),
    "Expected response to not have a " + status_class +
    " status code but got " + std::to_string (code)));
}

JSValue js_response_have_header (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "header() requires a header name");
    }
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const bool negated = magic_negated (magic);

    std::string header_name = js_to_string (ctx, argv[0]);

    // `Headers` orders by `CaseInsensitiveLess`, so this lookup answers the
    // case-insensitive match HTTP header names take - a script may ask for
    // `content-type` against a `Content-Type` the wire sent. The map holds one
    // value per name, so there is no earlier duplicate this could shadow.
    const auto found   = response->headers.find (header_name);
    const bool present = found != response->headers.end ();
    if (!check_holds (ctx, negated, present,
        "Expected response to have header '" + header_name + "'",
        "Expected response to not have header '" + header_name + "'")) {
        return JS_EXCEPTION;
    }
    if (argc < 2) {
        return JS_UNDEFINED;
    }

    // A header value is a string on the wire, and chai-postman compares the
    // expected value against it strictly. Coercing the expectation instead let
    // `header("X-Count", 5)` pass against the string "5" - a verdict Postman
    // does not give - so a non-string expectation fails the assertion here
    // rather than being stringified into agreement with the wire. Reached
    // without the header only under `not`, where chai-postman reads the value
    // of a header that is not there and throws; no value is what that means.
    const std::string actual = present ? found->second : std::string{};
    const bool matches =
    present && JS_IsString (argv[1]) && js_to_string (ctx, argv[1]) == actual;
    const JSValueConst expected = argv[1];
    return check_result (check_holds (
    ctx, negated, matches,
    [&] {
        return "Expected header '" + header_name + "' to be " +
        js_describe (ctx, expected) + " but got '" + actual + "'";
    },
    [&] {
        return "Expected header '" + header_name + "' to not be " +
        js_describe (ctx, expected);
    }));
}

// A pattern is whatever carries a callable `test`, which is how
// `expect(...).to.match` reads one: a regular expression literal is a real
// RegExp here and satisfies it, and a matcher object a script built itself is
// run rather than silently deep-equalled against the body. 1 when it is one
// and matched, 0 when it is one and did not match, 2 when it is not a pattern,
// -1 with an exception pending.
int body_pattern_match (JSContext* ctx, JSValueConst pattern, const std::string& body) {
    ScopedValue test_fn (ctx, JS_GetPropertyStr (ctx, pattern, "test"));
    // Reading `test` runs a getter if the script defined one, and a getter that
    // throws leaves the exception pending. Falling through to the deep-equal
    // branch there would report a mismatch and drop the script's own error -
    // the shape of silent wrongness this assertion was fixed for.
    if (JS_IsException (test_fn.get ())) {
        return -1;
    }
    if (!JS_IsFunction (ctx, test_fn.get ())) {
        return 2;
    }
    ScopedValue subject (ctx, JS_NewStringLen (ctx, body.data (), body.size ()));
    JSValueConst args[1]{ subject.get () };
    ScopedValue result (ctx, JS_Call (ctx, test_fn.get (), pattern, 1, args));
    if (JS_IsException (result.get ())) {
        return -1;
    }
    return JS_ToBool (ctx, result.get ()) == 1 ? 1 : 0;
}

JSValue check_body_deep_equal (JSContext* ctx, bool negated, const std::string& body, JSValueConst expected) {
    ScopedValue json (ctx, parse_body_json (ctx, body));
    int same = 0;
    if (!JS_IsUndefined (json.get ())) {
        DeepEqualPath path;
        same = js_deep_equal (ctx, json.get (), expected, 0, path, ZeroRule::SameValueZero);
        if (same < 0) {
            return JS_EXCEPTION;
        }
    }
    // An unparsable body equals no object, which under `not` is a pass, as
    // chai-postman's `_.isEqual(undefined, content)` is.
    return check_result (check_holds (
    ctx, negated, same == 1,
    [&] {
        return JS_IsUndefined (json.get ()) ?
        std::string ("Response body is not valid JSON") :
        "Expected response body to deeply equal " +
        js_describe (ctx, expected) + " but got " + describe_body (body);
    },
    [&] {
        return "Expected response body to not deeply equal " + js_describe (ctx, expected);
    }));
}

JSValue
js_response_have_body (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const bool negated      = magic_negated (magic);
    const std::string& body = response->body;

    // chai-postman's zero-argument form asserts only that there is a body.
    if (argc < 1) {
        return check_result (check_holds (ctx, negated, !body.empty (),
        "Expected response to have a body", "Expected response to not have a body"));
    }

    // chai-postman decides by the argument's type, and each form is a
    // different comparison: a string is exact, a regular expression is
    // executed against the body, an object is deep-equalled against the parsed
    // JSON. Vayu stringified all three and substring-searched the result, so a
    // partial string passed where Postman fails, and a regex or an object was
    // searched for as the literal text "/re/" or "[object Object]" - failing
    // where Postman passes.
    if (JS_IsString (argv[0])) {
        const std::string expected = js_to_string (ctx, argv[0]);
        return check_result (check_holds (ctx, negated, body == expected,
        "Expected response body to be '" + expected + "' but got " + describe_body (body),
        "Expected response body to not be '" + expected + "'"));
    }

    if (!JS_IsObject (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "body() expects a string, a regular expression or an object, got %s",
        js_type_name (ctx, argv[0]));
    }

    const int matched = body_pattern_match (ctx, argv[0], body);
    if (matched < 0) {
        return JS_EXCEPTION;
    }
    if (matched == 2) {
        return check_body_deep_equal (ctx, negated, body, argv[0]);
    }
    return check_result (check_holds (ctx, negated, matched == 1,
    "Expected response body to match the pattern but got " + describe_body (body),
    "Expected response body to not match the pattern"));
}

// ----------------------------------------------------------------------------
// jsonBody's path, read the way chai-postman reads it: lodash `_.has` and
// `_.get`, so `[0].id` on an array root, `a.b[2].c` and `a['b'].c` all name
// what they name there (#2528). Vayu split on `.` and nothing else, so a
// bracket was part of a property name and an array root held no path at all.
// ----------------------------------------------------------------------------

// What lodash's `reIsDeepProp` asks: a `.`, or a `[` closed later. A path with
// neither is one key, whatever characters it holds.
bool reads_as_deep_path (const std::string& path) {
    const auto open = path.find ('[');
    return path.find ('.') != std::string::npos ||
    (open != std::string::npos && path.find (']', open + 1) != std::string::npos);
}

// lodash unescapes a quoted key by dropping each backslash and keeping the
// character it escaped: `\'` is `'`, `\\` is `\`.
std::string unescape_quoted_key (const std::string& raw) {
    std::string out;
    for (size_t i = 0; i < raw.size (); i++) {
        if (raw[i] != '\\') {
            out += raw[i];
        } else if (i + 1 < raw.size () && raw[i + 1] == '\\') {
            out += '\\';
            i++;
        }
    }
    return out;
}

// A bracketed segment and the index just past its `]`.
using BracketSegment = std::optional<std::pair<std::string, size_t>>;

// `['key']` / `["key"]` from the quote at @p quote_at. The key ends at the
// first unescaped quote, which must be followed by `]`; anything else is not a
// quoted segment, as in lodash's pattern.
BracketSegment read_quoted_segment (const std::string& path, size_t quote_at) {
    const char quote = path[quote_at];
    std::string raw;
    for (size_t i = quote_at + 1; i < path.size (); i++) {
        if (path[i] == quote) {
            if (i + 1 < path.size () && path[i + 1] == ']') {
                return std::make_pair (unescape_quoted_key (raw), i + 2);
            }
            return std::nullopt;
        }
        if (path[i] == '\\') {
            if (i + 1 >= path.size ()) {
                return std::nullopt;
            }
            raw += path[i++];
        }
        raw += path[i];
    }
    return std::nullopt;
}

bool is_digit (char c) {
    return c >= '0' && c <= '9';
}

// `[0]`, `[-1]`, `[1.5]` from the character after the `[`: lodash's
// `-?\d+(?:\.\d+)?` followed by `]`.
BracketSegment read_numeric_segment (const std::string& path, size_t start) {
    size_t at = start;
    if (at < path.size () && path[at] == '-') {
        at++;
    }
    const size_t digits = at;
    while (at < path.size () && is_digit (path[at])) {
        at++;
    }
    if (at == digits) {
        return std::nullopt;
    }
    if (at + 1 < path.size () && path[at] == '.' && is_digit (path[at + 1])) {
        at++;
        while (at < path.size () && is_digit (path[at])) {
            at++;
        }
    }
    if (at >= path.size () || path[at] != ']') {
        return std::nullopt;
    }
    return std::make_pair (path.substr (start, at - start), at + 1);
}

BracketSegment read_bracket_segment (const std::string& path, size_t open) {
    const size_t inner = open + 1;
    if (inner >= path.size ()) {
        return std::nullopt;
    }
    if (path[inner] == '"' || path[inner] == '\'') {
        return read_quoted_segment (path, inner);
    }
    return read_numeric_segment (path, inner);
}

// lodash's empty-segment rule: a `.` or `[]` followed by another, or by the
// end, holds an empty key between them (`a..b` is `a`, ``, `b`).
bool opens_empty_segment (const std::string& path, size_t at) {
    size_t after = 0;
    if (path[at] == '.') {
        after = at + 1;
    } else if (path.compare (at, 2, "[]") == 0) {
        after = at + 2;
    } else {
        return false;
    }
    return after == path.size () || path[after] == '.' ||
    path.compare (after, 2, "[]") == 0;
}

/**
 * lodash's `stringToPath`. Its pattern, tried in order at each position: a run
 * of anything but `.`, `[` and `]` is a key; a bracket holding a number or a
 * quoted string is that key; an empty segment is an empty key; anything else
 * is skipped, which is how `[name]` reads as the key `name`.
 */
std::vector<std::string> lodash_path_segments (const std::string& path) {
    std::vector<std::string> segments;
    if (!path.empty () && path.front () == '.') {
        segments.emplace_back ();
    }
    size_t at = 0;
    while (at < path.size ()) {
        const char c = path[at];
        if (c != '.' && c != '[' && c != ']') {
            const size_t end = std::min (path.find_first_of (".[]", at), path.size ());
            segments.push_back (path.substr (at, end - at));
            at = end;
            continue;
        }
        if (c == '[') {
            if (auto bracket = read_bracket_segment (path, at)) {
                segments.push_back (std::move (bracket->first));
                at = bracket->second;
                continue;
            }
        }
        if (opens_empty_segment (path, at)) {
            segments.emplace_back ();
        }
        at++;
    }
    return segments;
}

/**
 * `_.has (root, path)` and `_.get (root, path)` at once: 1 with the value in
 * @p out when every segment is an own property of the value before it, 0 when
 * one is not, -1 with an exception pending.
 *
 * Own, as `_.has` asks: a JSON array's `length` is one, its `map` is not. The
 * path is one key when lodash would read it as one - no `.` or `[...]` in it,
 * or a key the root itself holds, so `{"a.b": 1}` answers `a.b` whole.
 */
int read_json_path (JSContext* ctx, JSValueConst root, const std::string& path, JSValue& out) {
    bool one_key = !reads_as_deep_path (path);
    if (!one_key && JS_IsObject (root)) {
        JSAtom whole    = JS_NewAtomLen (ctx, path.data (), path.size ());
        const int found = JS_HasProperty (ctx, root, whole);
        JS_FreeAtom (ctx, whole);
        if (found < 0) {
            return -1;
        }
        one_key = found == 1;
    }
    const std::vector<std::string> segments =
    one_key ? std::vector<std::string>{ path } : lodash_path_segments (path);

    JSValue current = JS_DupValue (ctx, root);
    for (const auto& key : segments) {
        if (!JS_IsObject (current)) {
            JS_FreeValue (ctx, current);
            return 0;
        }
        JSAtom atom   = JS_NewAtomLen (ctx, key.data (), key.size ());
        const int own = JS_GetOwnProperty (ctx, nullptr, current, atom);
        JSValue next = own > 0 ? JS_GetProperty (ctx, current, atom) : JS_UNDEFINED;
        JS_FreeAtom (ctx, atom);
        JS_FreeValue (ctx, current);
        if (own <= 0) {
            return own;
        }
        if (JS_IsException (next)) {
            return -1;
        }
        current = next;
    }
    out = current;
    return 1;
}

JSValue js_response_have_jsonBody (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const bool negated = magic_negated (magic);
    ScopedValue json (ctx, parse_body_json (ctx, response->body));
    const bool valid = !JS_IsUndefined (json.get ());

    // No-arg form asserts only that the body is valid JSON (Postman semantics).
    if (argc < 1) {
        return check_result (check_holds (ctx, negated, valid, "Response body is not valid JSON",
        "Expected response body to not be valid JSON"));
    }
    // chai-postman reads a non-string path as no assertion at all, a silent
    // pass; a path is refused here instead.
    if (!JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "jsonBody() expects a property path string, got %s",
        js_type_name (ctx, argv[0]));
    }
    const std::string prop_path = js_to_string (ctx, argv[0]);
    // An unparsable body holds no path, which is said as what it is.
    if (!valid && !negated) {
        return throw_assertion_failure (ctx, "Response body is not valid JSON");
    }

    JSValue found = JS_UNDEFINED;
    const int has = valid ? read_json_path (ctx, json.get (), prop_path, found) : 0;
    if (has < 0) {
        return JS_EXCEPTION;
    }
    ScopedValue value (ctx, found);
    if (!check_holds (ctx, negated, has == 1,
        "Expected response body to have property '" + prop_path + "'",
        "Expected response body to not have property '" + prop_path + "'")) {
        return JS_EXCEPTION;
    }

    // chai-postman's two-argument form is `_.has(json, path)` and then
    // `_.isEqual(_.get(json, path), value)`. Vayu walked the path and stopped,
    // never reading the expected value at all, so every value-checking
    // assertion in an imported suite passed on any value the path held - the
    // silent false pass #998 was filed for.
    if (argc < 2) {
        return JS_UNDEFINED;
    }
    DeepEqualPath path;
    const int same =
    js_deep_equal (ctx, value.get (), argv[1], 0, path, ZeroRule::SameValueZero);
    if (same < 0) {
        return JS_EXCEPTION;
    }
    const JSValueConst expected = argv[1];
    return check_result (check_holds (
    ctx, negated, same == 1,
    [&] {
        return "Expected response body property '" + prop_path + "' to deeply equal " +
        js_describe (ctx, expected) + " but got " + js_describe (ctx, value.get ());
    },
    [&] {
        return "Expected response body property '" + prop_path +
        "' to not deeply equal " + js_describe (ctx, expected);
    }));
}

// chai-postman's `jsonSchema(schema, options)`, against the body as
// `pm.response.json()` reads it. `options` is ajv's and is not read: the
// validator is the engine's draft-07 one (`json_schema_failure`).
JSValue js_response_have_json_schema (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "jsonSchema() requires a schema");
    }
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    ScopedValue json (ctx, parse_body_json (ctx, response->body));
    // `json()` throws in chai-postman on a body that is not JSON, so this
    // fails under `not` as well: there is no document to judge either way.
    if (JS_IsUndefined (json.get ())) {
        return throw_assertion_failure (ctx, "Response body is not valid JSON");
    }
    const auto failure =
    json_schema_failure (ctx, json.get (), argv[0], magic_negated (magic));
    if (!failure) {
        return JS_EXCEPTION;
    }
    if (!failure->empty ()) {
        return throw_assertion_failure (ctx, *failure);
    }
    return JS_UNDEFINED;
}

// `to.have.responseTime` / `to.have.responseSize` - chai-postman's chainable
// methods, which retarget the assertion at a number: `.responseTime.below(200)`
// is pm.expect's `below` on the time, and `responseTime(n)` asserts it equals
// n. The time is `pm.response.responseTime`; the size is `size()`'s body and
// header together, which is what chai-postman adds up. The row is the
// `ResponseMeasure`.
JSValue js_response_have_measure (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const auto which = static_cast<ResponseMeasure> (magic_row (magic));
    const ResponseSizeBytes size = response_size_bytes (*response);
    const double measured        = which == ResponseMeasure::Time ?
    response->timing.total_ms :
    static_cast<double> (size.body + size.header);
    return response_measure_chain (ctx, measured, magic_negated (magic), which);
}

// ============================================================================
// pm.response.to.be Status-Class Assertions
// ============================================================================

// Each matcher asserts the status code falls in [lo, hi]. Single-code matchers
// set lo == hi. `expectation` completes "Expected response to have ...".
struct StatusClassMatcher {
    const char* name;
    int lo;
    int hi;
    const char* expectation;
};

// Status ranges only. The body-shape assertions (`json`, `withBody`) are not
// ranges, so they get their own getters below.
//
// The named codes compare the code alone, where chai-postman compares the
// reason phrase as well. The phrase is the server's to choose, and two of
// chai-postman's rows want one no standard server sends ("Unauthorised" for
// `unauthorised`, "Acceptable" for `notAcceptable`), so comparing it fails a
// correct code; the difference is in docs/app/pm-api-compatibility.md.
constexpr auto status_class_matchers = std::to_array<StatusClassMatcher> ({
{ "info", 100, 199, "a 1xx status code" },
// `ok` is a named code in chai-postman, not a class: it asserts 200, so a
// 204 passes here and fails in Postman while the two ranges agree. Vayu
// scripts that meant the class have `success`, which is the 2xx one in
// both - the migration note is in docs/app/pm-api-compatibility.md.
{ "ok", 200, 200, "status 200" },
{ "success", 200, 299, "a 2xx status code" },
{ "accepted", 202, 202, "status 202" },
{ "withoutContent", 204, 204, "status 204" },
{ "redirection", 300, 399, "a 3xx status code" },
{ "clientError", 400, 499, "a 4xx status code" },
{ "badRequest", 400, 400, "status 400" },
{ "unauthorized", 401, 401, "status 401" },
{ "unauthorised", 401, 401, "status 401" },
{ "forbidden", 403, 403, "status 403" },
{ "notFound", 404, 404, "status 404" },
{ "notAcceptable", 406, 406, "status 406" },
{ "rateLimited", 429, 429, "status 429" },
{ "serverError", 500, 599, "a 5xx status code" },
{ "error", 400, 599, "a 4xx or 5xx status code" },
});

// `magic` carries the status_class_matchers row. Registered as a getter, never
// a plain property: `pm.response.to.be.ok` is written without parentheses, so a
// function-valued property would be a discarded reference that asserts nothing
// (the defect ExpectTrueFalseAssertsOnAccess pins for pm.expect).
JSValue js_response_be_status_class (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }

    const StatusClassMatcher& matcher = status_class_matchers.at (magic_row (magic));
    const int code        = response->status_code;
    const std::string got = " but got " + std::to_string (code);
    return check_result (check_holds (ctx, magic_negated (magic),
    code >= matcher.lo && code <= matcher.hi,
    std::string ("Expected response to have ") + matcher.expectation + got,
    std::string ("Expected response to not have ") + matcher.expectation + got));
}

JSValue
js_response_be_json (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    ScopedValue json (ctx, parse_body_json (ctx, response->body));
    return check_result (check_holds (ctx, magic_negated (magic),
    !JS_IsUndefined (json.get ()), "Expected response body to be valid JSON",
    "Expected response body to not be valid JSON"));
}

JSValue js_response_be_with_body (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    return check_result (
    check_holds (ctx, magic_negated (magic), !response->body.empty (),
    "Expected response to have a body", "Expected response to not have a body"));
}

} // namespace

// ============================================================================
// pm.response.to chain objects
// ============================================================================

// Every link in the chain carries this class. Its exotic hook turns an
// unrecognised member into a throw: `pm.response.to.be.ok` is an expression
// statement, so a member that does not exist evaluates to undefined and
// asserts nothing - a green test against a broken API, which is strictly worse
// than a missing matcher that fails loudly. Own properties are resolved before
// the hook runs, so it only ever sees names nothing implements.
JSClassID response_chain_class_id = 0;

namespace {

int response_chain_unknown_member (JSContext* ctx,
JSPropertyDescriptor* desc,
JSValueConst obj,
JSAtom prop) {
    (void)desc;

    // The opaque path doubles as the armed flag. Defining a property looks up
    // the existing own property first, so a hook that threw from the moment the
    // object existed would reject the chain's own members as they are installed
    // - arm_response_chain_object runs last, once every member is in place.
    const auto* path =
    static_cast<const char*> (JS_GetOpaque (obj, response_chain_class_id));
    if (!path) {
        return 0;
    }

    return report_unknown_chain_member (ctx, obj, prop, path);
}

// Value-initialized and then assigned rather than written as a designated
// initializer: this is a QuickJS C struct, so it cannot carry default member
// initializers, and naming one of its seven hooks leaves the other six as
// -Wmissing-field-initializers warnings.
JSClassExoticMethods response_chain_exotic = [] {
    JSClassExoticMethods exotic{};
    exotic.get_own_property = response_chain_unknown_member;
    return exotic;
}();

} // namespace

JSClassDef response_chain_class = { .class_name = "ResponseAssertionChain",
    .finalizer                                  = nullptr,
    .gc_mark                                    = nullptr,
    .call                                       = nullptr,
    .exotic                                     = &response_chain_exotic };

namespace {

JSValue create_response_chain_object (JSContext* ctx) {
    return JS_NewObjectClass (ctx, response_chain_class_id);
}

// Arms the unknown-member hook. Call once the object holds every member it is
// meant to have; `path` names the chain in the error and must outlive the
// object, so every caller passes a string literal and the class needs no
// finalizer.
void arm_response_chain_object (JSValue obj, const char* path) {
    (void)JS_SetOpaque (obj, const_cast<char*> (path));
}

// One polarity of the chain: the paths its three links name in an error, and
// whether its matchers are negated.
struct ResponseChainLinks {
    const char* to;
    const char* have;
    const char* be;
    bool negated;
};
constexpr ResponseChainLinks POSITIVE_CHAIN{ "pm.response.to",
    "pm.response.to.have", "pm.response.to.be", false };
constexpr ResponseChainLinks NEGATED_CHAIN{ "pm.response.to.not",
    "pm.response.to.not.have", "pm.response.to.not.be", true };

// `to.have`'s calls. The row is unused; the magic carries the polarity.
struct ResponseMatcher {
    const char* name;
    JSCFunctionMagic* fn;
    int length;
};
constexpr auto have_matchers = std::to_array<ResponseMatcher> ({
{ "status", js_response_have_status, 1 },
{ "statusCode", js_response_have_status_code, 1 },
{ "statusReason", js_response_have_status_reason, 1 },
{ "statusCodeClass", js_response_have_status_code_class, 1 },
{ "header", js_response_have_header, 2 },
{ "body", js_response_have_body, 1 },
{ "jsonBody", js_response_have_jsonBody, 1 },
{ "jsonSchema", js_response_have_json_schema, 2 },
});

// A getter with @p magic, so the member asserts (or retargets) on access.
void define_magic_getter (JSContext* ctx, JSValue obj, const char* name, JSCFunctionMagic* fn, int magic) {
    JSAtom atom = JS_NewAtom (ctx, name);
    JS_DefinePropertyGetSet (ctx, obj, atom,
    JS_NewCFunctionMagic (ctx, fn, name, 0, JS_CFUNC_generic_magic, magic),
    JS_UNDEFINED, 0);
    JS_FreeAtom (ctx, atom);
}

// Create the pm.response.to.have chain object
JSValue create_response_have_object (JSContext* ctx, const ResponseChainLinks& links) {
    JSValue have = create_response_chain_object (ctx);
    if (JS_IsException (have)) {
        return have;
    }
    const int polarity = matcher_magic (0, links.negated);
    for (const auto& matcher : have_matchers) {
        JS_SetPropertyStr (ctx, have, matcher.name,
        JS_NewCFunctionMagic (ctx, matcher.fn, matcher.name, matcher.length,
        JS_CFUNC_generic_magic, polarity));
    }
    define_magic_getter (ctx, have, "responseTime", js_response_have_measure,
    matcher_magic (static_cast<size_t> (ResponseMeasure::Time), links.negated));
    define_magic_getter (ctx, have, "responseSize", js_response_have_measure,
    matcher_magic (static_cast<size_t> (ResponseMeasure::Size), links.negated));
    arm_response_chain_object (have, links.have);
    return have;
}

// Create the pm.response.to.be chain object
JSValue create_response_be_object (JSContext* ctx, const ResponseChainLinks& links) {
    JSValue be = create_response_chain_object (ctx);
    if (JS_IsException (be)) {
        return be;
    }
    for (size_t row = 0; row < status_class_matchers.size (); row++) {
        define_magic_getter (ctx, be, status_class_matchers.at (row).name,
        js_response_be_status_class, matcher_magic (row, links.negated));
    }
    const int polarity = matcher_magic (0, links.negated);
    define_magic_getter (ctx, be, "json", js_response_be_json, polarity);
    define_magic_getter (ctx, be, "withBody", js_response_be_with_body, polarity);
    arm_response_chain_object (be, links.be);
    return be;
}

JSValue js_response_chain_self (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    return JS_DupValue (ctx, this_val);
}

// Create the pm.response.to chain object, and through `not` its negated twin.
JSValue create_response_to_object (JSContext* ctx, const ResponseChainLinks& links) {
    JSValue to = create_response_chain_object (ctx);
    if (JS_IsException (to)) {
        return to;
    }
    JS_SetPropertyStr (ctx, to, "have", create_response_have_object (ctx, links));
    JS_SetPropertyStr (ctx, to, "be", create_response_be_object (ctx, links));
    if (links.negated) {
        // `not` sets, it never toggles - pm.expect's rule (#883) - so
        // `to.not.not` is still the negated chain.
        JSAtom atom = JS_NewAtom (ctx, "not");
        JS_DefinePropertyGetSet (ctx, to, atom,
        JS_NewCFunction (ctx, js_response_chain_self, "not", 0), JS_UNDEFINED, 0);
        JS_FreeAtom (ctx, atom);
    } else {
        JS_SetPropertyStr (ctx, to, "not", create_response_to_object (ctx, NEGATED_CHAIN));
    }
    arm_response_chain_object (to, links.to);
    return to;
}

} // namespace

// ============================================================================
// Header accessors (pm.request.headers / pm.response.headers)
// ============================================================================

// Name a rejected value the way the script author wrote it, so the error says
// "got number" rather than showing them a coerced "[object Object]". Shared by
// every pm surface, through pm_internal.hpp.
const char* js_type_name (JSContext* ctx, JSValueConst value) {
    if (JS_IsUndefined (value))
        return "undefined";
    if (JS_IsNull (value))
        return "null";
    if (JS_IsBool (value))
        return "boolean";
    if (JS_IsNumber (value))
        return "number";
    if (JS_IsString (value))
        return "string";
    if (JS_IsFunction (ctx, value))
        return "function";
    if (JS_IsArray (value))
        return "array";
    if (JS_IsObject (value))
        return "object";
    return "value";
}

namespace {

// The methods live on the very object that holds the header entries, because
// `apply_pm_request_writeback` reads *that* object - so a header added by
// `add()` and one added by assignment have to be the same property or the two
// views disagree about what is sent.
//
// They must therefore be invisible to the write-back, which enumerates own
// **enumerable** string properties: an enumerable `get` would be read as a
// header whose value is a function and would fail the whole write-back. Hence
// the two flag sets below - methods without JS_PROP_ENUMERABLE, entries with
// JS_PROP_C_W_E. Entries are *defined* rather than set so a header literally
// named `get` overwrites the method attributes as well as its value and still
// reaches the wire; a silently dropped header is the defect this whole surface
// exists to avoid, and a shadowed method throws loudly instead.
constexpr int HEADER_METHOD_FLAGS = JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE;

} // namespace

void define_header_entry (JSContext* ctx,
JSValue headers,
const std::string& name,
const std::string& value) {
    JS_DefinePropertyValueStr (ctx, headers, name.c_str (),
    JS_NewString (ctx, value.c_str ()), JS_PROP_C_W_E);
}

namespace {

// The own enumerable key naming `name`, spelled the way the object spells it.
// HTTP header names are case-insensitive and JS object keys are not, so an
// exact lookup would miss `Content-Type` on a response (whose keys the HTTP
// client has lower-cased) and `content-type` on a request (whose keys keep
// whatever the user typed).
/// The header names the object holds, in the order it holds them - which is the
/// order the source `Headers` map was walked in when the entries were defined,
/// and so the order every read below reports. The methods are non-enumerable
/// (HEADER_METHOD_FLAGS), so they are never among the names. `std::nullopt`
/// means QuickJS left an exception pending.
std::optional<std::vector<std::string>> header_key_order (JSContext* ctx, JSValueConst headers) {
    std::vector<std::string> keys;
    if (!js_own_enumerable_keys (ctx, headers, keys)) {
        return std::nullopt;
    }
    return keys;
}

std::optional<std::string>
find_header_key (JSContext* ctx, JSValueConst headers, const std::string& name) {
    auto keys = header_key_order (ctx, headers);
    if (!keys) {
        return std::nullopt;
    }
    for (auto& key : *keys) {
        if (vayu::utils::ascii_lower_equal (key, name)) {
            return std::move (key);
        }
    }
    return std::nullopt;
}

// `this` is the header object the method was reached through. Detaching a
// method from it (`const get = pm.response.headers.get; get('x')`) leaves
// `this` undefined, which would otherwise read as "no such header" - a wrong
// answer dressed as a real one.
bool header_this_is_usable (JSContext* ctx, JSValueConst this_val, const char* member) {
    if (JS_IsObject (this_val) && !JS_IsFunction (ctx, this_val)) {
        return true;
    }
    JS_ThrowTypeError (ctx,
    "headers.%s must be called on a headers object (got %s) - call it as "
    "pm.request.headers.%s(...) rather than detaching it",
    member, js_type_name (ctx, this_val), member);
    return false;
}

// A header name is a non-empty string or nothing. Coercing a number here would
// invent a field name; the write-back refuses non-primitive values for the same
// reason.
std::optional<std::string>
read_header_name_arg (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString (argv[0])) {
        JS_ThrowTypeError (ctx, "headers.%s(name) needs a header name string, got %s",
        member, argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
        return std::nullopt;
    }
    std::string name = js_to_string (ctx, argv[0]);
    if (name.empty ()) {
        JS_ThrowTypeError (ctx, "headers.%s(name) needs a non-empty header name", member);
        return std::nullopt;
    }
    return name;
}

// The same primitive set the write-back accepts, so a value that survives a
// method call is a value that survives being sent.
std::optional<std::string> read_header_value_arg (JSContext* ctx,
const char* member,
const std::string& name,
JSValueConst value) {
    if (JS_IsString (value) || JS_IsNumber (value) || JS_IsBool (value)) {
        return js_to_string (ctx, value);
    }
    JS_ThrowTypeError (ctx, "headers.%s: value for '%s' must be a string, number or boolean, got %s",
    member, name.c_str (), js_type_name (ctx, value));
    return std::nullopt;
}

JSValue js_headers_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "get")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "get", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto key = find_header_key (ctx, this_val, *name);
    if (!key) {
        // Postman returns undefined for an absent header; a throw here would
        // make the common `if (headers.get(x))` guard unwritable.
        return JS_UNDEFINED;
    }
    return JS_GetPropertyStr (ctx, this_val, key->c_str ());
}

// Postman's PropertyList spells this `has(key, value?)` and checks the value
// when one is given. Vayu read only the name, so `has(name, value)` answered
// true for any value the header held - a check that looked like one and was
// not. The comparison is strict against the wire string, as `to.have.header`'s
// is: a non-string expectation matches nothing rather than being coerced.
JSValue js_headers_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "has")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "has", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto key = find_header_key (ctx, this_val, *name);
    if (!key) {
        return JS_NewBool (ctx, 0);
    }
    if (argc < 2) {
        return JS_NewBool (ctx, 1);
    }
    if (!JS_IsString (argv[1])) {
        return JS_NewBool (ctx, 0);
    }
    JSValue stored           = JS_GetPropertyStr (ctx, this_val, key->c_str ());
    const std::string actual = js_to_string (ctx, stored);
    JS_FreeValue (ctx, stored);
    return JS_NewBool (ctx, actual == js_to_string (ctx, argv[1]) ? 1 : 0);
}

// Postman's header object is a PropertyList, and the six reads below are the
// half of it that only looks. `each` in particular is an everyday idiom - it
// threw here, which is how an imported script died on a line that reads nothing
// - so all six install on the response and sendRequest objects too, ahead of
// the `mutators` gate.
//
// What they cannot report is what this object no longer holds: `Headers` is a
// single-valued case-insensitive map, so a name the server sent twice arrived
// folded with ", " and the wire order is gone with it. The order below is the
// map's; the fold is documented beside these methods in both script docs.

/// One `{ key, value }` member - the shape Postman's PropertyList hands its
/// iterator, and the shape `add`/`upsert` already read back.
JSValue header_member (JSContext* ctx, JSValueConst headers, const std::string& key) {
    JSValue member = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, member, "key", JS_NewStringLen (ctx, key.data (), key.size ()));
    JS_SetPropertyStr (
    ctx, member, "value", JS_GetPropertyStr (ctx, headers, key.c_str ()));
    return member;
}

/// Every member as an array. `all()` itself, and the list `each()` walks - built
/// once, so a callback that removes a header does not shorten the walk under it.
JSValue header_member_list (JSContext* ctx,
JSValueConst headers,
const std::vector<std::string>& keys) {
    JSValue list  = JS_NewArray (ctx);
    uint32_t next = 0;
    for (const auto& key : keys) {
        JS_SetPropertyUint32 (ctx, list, next++, header_member (ctx, headers, key));
    }
    return list;
}

/// A name, or the `{ key, value }` member `all()` and `one()` hand back - the
/// two spellings `indexOf` answers to.
std::optional<std::string>
read_header_member_arg (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc >= 1 && JS_IsObject (argv[0]) && !JS_IsFunction (ctx, argv[0]) &&
    !JS_IsArray (argv[0])) {
        JSValue js_key = JS_GetPropertyStr (ctx, argv[0], "key");
        JSValueConst only[1]{ js_key };
        auto name = read_header_name_arg (ctx, member, 1, only);
        JS_FreeValue (ctx, js_key);
        return name;
    }
    return read_header_name_arg (ctx, member, argc, argv);
}

/// `headers.all()` - every header as a `{ key, value }`, in key order.
JSValue js_headers_all (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    if (!header_this_is_usable (ctx, this_val, "all")) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    return header_member_list (ctx, this_val, *keys);
}

/// `headers.count()` - how many headers, which is `all().length` without
/// building the array.
JSValue js_headers_count (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)argc;
    (void)argv;
    if (!header_this_is_usable (ctx, this_val, "count")) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    return JS_NewInt32 (ctx, static_cast<int32_t> (keys->size ()));
}

/**
 * `headers.each(fn, thisArg)` - the iteration idiom, with Postman's arguments.
 *
 * postman-collection's `each` is `_.forEach(members, iterator.bind(context))`,
 * so the callback is handed `(member, index, list)` and the optional second
 * argument becomes its `this`. Passing only the member would have been the
 * smaller change and would silently hand `undefined` to a script that reads the
 * index - the class of quiet wrong answer this surface exists to close.
 */
JSValue js_headers_each (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "each")) {
        return JS_EXCEPTION;
    }
    if (argc < 1 || !JS_IsFunction (ctx, argv[0])) {
        return JS_ThrowTypeError (ctx, "headers.each(fn) needs a function, got %s",
        argc < 1 ? "no argument" : js_type_name (ctx, argv[0]));
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }

    JSValue list                = header_member_list (ctx, this_val, *keys);
    const JSValueConst this_arg = argc >= 2 ? argv[1] : JS_UNDEFINED;
    JSValue outcome             = JS_UNDEFINED;
    for (uint32_t i = 0; i < keys->size (); i++) {
        JSValue member = JS_GetPropertyUint32 (ctx, list, i);
        JSValue index  = JS_NewInt32 (ctx, static_cast<int32_t> (i));
        JSValueConst args[3]{ member, index, list };
        JSValue returned = JS_Call (ctx, argv[0], this_arg, 3, args);
        JS_FreeValue (ctx, member);
        JS_FreeValue (ctx, index);
        if (JS_IsException (returned)) {
            // A throw out of the callback is the script's, not ours - it goes
            // back up as it is rather than being reported as an `each` failure.
            outcome = JS_EXCEPTION;
            break;
        }
        JS_FreeValue (ctx, returned);
    }
    JS_FreeValue (ctx, list);
    return outcome;
}

/**
 * `headers.toObject(excludeDisabled, caseSensitive)` - Postman's signature.
 *
 * Its header list is indexed case-insensitively, so `toObject()` there
 * **lower-cases every key**, and only `caseSensitive` keeps the spelling the
 * header was stored with. Copying the object's own keys instead - which is what
 * a plain enumeration would do - reads as the harmless choice and is not:
 * `pm.request.headers` keeps whatever the user typed, so
 * `toObject()['content-type']` would answer `undefined` here against a request
 * carrying `Content-Type`, and answer correctly in Postman.
 *
 * The other two switches Postman takes decide nothing here: `multiValue` has no
 * duplicate to unfold (they arrived folded), and `sanitizeKeys` no falsy key to
 * drop, since a header name is a non-empty string on both surfaces.
 */
JSValue js_headers_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "toObject")) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    const bool case_sensitive = argc >= 2 && JS_ToBool (ctx, argv[1]) == 1;

    JSValue out = JS_NewObject (ctx);
    for (const auto& key : *keys) {
        JSValue value = JS_GetPropertyStr (ctx, this_val, key.c_str ());
        // A case-insensitive index is keyed by the folded name, which is the
        // spelling Postman's `toObject()` hands back.
        const std::string prop = case_sensitive ? key : vayu::utils::ascii_lower (key);
        JS_SetPropertyStr (ctx, out, prop.c_str (), value);
    }
    return out;
}

/// `headers.one(name)` - the member rather than its value, `undefined` when the
/// header is absent. `get` is the value half of the same lookup.
JSValue js_headers_one (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "one")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "one", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto key = find_header_key (ctx, this_val, *name);
    if (!key) {
        return JS_UNDEFINED;
    }
    return header_member (ctx, this_val, *key);
}

/**
 * `headers.indexOf(name)` - the header's position in `all()`, `-1` when absent.
 *
 * Postman takes a member object here as well as a name, and finds it by
 * identity in its own member list. The members handed out here are built per
 * call, so identity would answer `-1` for a member of this very list; matching
 * the object's `key` answers what Postman answers for that case, and `-1` for
 * an object naming a header this list does not hold, as Postman's does.
 */
JSValue js_headers_index_of (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "indexOf")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_member_arg (ctx, "indexOf", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    auto keys = header_key_order (ctx, this_val);
    if (!keys) {
        return JS_EXCEPTION;
    }
    for (uint32_t i = 0; i < keys->size (); i++) {
        if (vayu::utils::ascii_lower_equal ((*keys)[i], *name)) {
            return JS_NewInt32 (ctx, static_cast<int32_t> (i));
        }
    }
    return JS_NewInt32 (ctx, -1);
}

// Postman spells this `add({ key, value })`; Bruno spells it `(name, value)`.
// Both are accepted because both are idioms a user pastes in, and getting it
// wrong in either direction would otherwise name a header "[object Object]".
struct HeaderPair {
    std::string name;
    std::string value;
};

std::optional<HeaderPair>
read_header_pair_args (JSContext* ctx, const char* member, int argc, JSValueConst* argv) {
    if (argc >= 2) {
        auto name = read_header_name_arg (ctx, member, argc, argv);
        if (!name) {
            return std::nullopt;
        }
        auto value = read_header_value_arg (ctx, member, *name, argv[1]);
        if (!value) {
            return std::nullopt;
        }
        return HeaderPair{ *name, *value };
    }

    if (argc == 1 && JS_IsObject (argv[0]) && !JS_IsFunction (ctx, argv[0]) &&
    !JS_IsArray (argv[0])) {
        JSValue js_key   = JS_GetPropertyStr (ctx, argv[0], "key");
        JSValue js_value = JS_GetPropertyStr (ctx, argv[0], "value");
        JSValueConst pair[2]{ js_key, js_value };
        auto name = read_header_name_arg (ctx, member, 1, pair);
        std::optional<std::string> value;
        if (name) {
            value = read_header_value_arg (ctx, member, *name, js_value);
        }
        JS_FreeValue (ctx, js_key);
        JS_FreeValue (ctx, js_value);
        if (!name || !value) {
            return std::nullopt;
        }
        return HeaderPair{ *name, *value };
    }

    JS_ThrowTypeError (ctx, "headers.%s takes ({ key, value }) or (name, value)", member);
    return std::nullopt;
}

// magic: 0 = add (refuses an existing name), 1 = upsert (replaces it).
JSValue js_request_headers_add_or_upsert (JSContext* ctx,
JSValueConst this_val,
int argc,
JSValueConst* argv,
int magic) {
    const bool is_upsert = magic == 1;
    const char* member   = is_upsert ? "upsert" : "add";
    if (!header_this_is_usable (ctx, this_val, member)) {
        return JS_EXCEPTION;
    }
    auto pair = read_header_pair_args (ctx, member, argc, argv);
    if (!pair) {
        return JS_EXCEPTION;
    }

    auto existing = find_header_key (ctx, this_val, pair->name);
    if (existing && !is_upsert) {
        // Postman's HeaderList holds duplicates and `add` appends one. This
        // object cannot: it is a JS object read into a case-insensitive
        // `Headers` map, so a second `X-Foo` has nowhere to live. Silently
        // behaving as `upsert` would hide the difference; refusing names it.
        return JS_ThrowTypeError (ctx,
        "headers.add: '%s' is already set (as '%s') and a request cannot carry "
        "it twice - use headers.upsert() to replace it",
        pair->name.c_str (), existing->c_str ());
    }

    // Write through the spelling already present, so `upsert('content-type')`
    // on a request holding `Content-Type` replaces it instead of creating a
    // second casing the write-back would then refuse as a clash.
    define_header_entry (ctx, this_val, existing ? *existing : pair->name, pair->value);
    return JS_UNDEFINED;
}

JSValue js_request_headers_remove (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (!header_this_is_usable (ctx, this_val, "remove")) {
        return JS_EXCEPTION;
    }
    auto name = read_header_name_arg (ctx, "remove", argc, argv);
    if (!name) {
        return JS_EXCEPTION;
    }
    // Removing a header that is not there is idempotent, not a mistake -
    // `remove('Authorization')` on a request that never had one is exactly what
    // a defensive script writes.
    if (auto key = find_header_key (ctx, this_val, *name)) {
        JSAtom atom = JS_NewAtom (ctx, key->c_str ());
        JS_DeleteProperty (ctx, this_val, atom, 0);
        JS_FreeAtom (ctx, atom);
    }
    return JS_UNDEFINED;
}

} // namespace

// `mutators` gates the three that only mean something before the request is
// sent. They are still installed on a test script's pm.request.headers, where
// they mutate an object nothing reads back - the same no-op that assignment
// already is there, documented in both script docs.
void install_header_methods (JSContext* ctx, JSValue headers, bool mutators) {
    // The reads are eight of one shape, so they are a table and a loop - the
    // idiom `build_query_object` (pm_request_url.cpp) uses for the same job. The three mutators are
    // not: two of them share one implementation through a magic number, and
    // spelling that in the table would cost more than it saves.
    struct HeaderRead {
        const char* name;
        JSCFunction* fn;
        int length;
    };
    static constexpr std::array<HeaderRead, 8> READS = {
        HeaderRead{ "get", js_headers_get, 1 },
        HeaderRead{ "has", js_headers_has, 1 },
        HeaderRead{ "each", js_headers_each, 1 },
        HeaderRead{ "all", js_headers_all, 0 },
        HeaderRead{ "count", js_headers_count, 0 },
        HeaderRead{ "toObject", js_headers_to_object, 0 },
        HeaderRead{ "one", js_headers_one, 1 },
        HeaderRead{ "indexOf", js_headers_index_of, 1 },
    };
    for (const auto& read : READS) {
        JS_DefinePropertyValueStr (ctx, headers, read.name,
        JS_NewCFunction (ctx, read.fn, read.name, read.length), HEADER_METHOD_FLAGS);
    }

    if (!mutators) {
        return;
    }
    JS_DefinePropertyValueStr (ctx, headers, "add",
    JS_NewCFunctionMagic (
    ctx, js_request_headers_add_or_upsert, "add", 2, JS_CFUNC_generic_magic, 0),
    HEADER_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, headers, "upsert",
    JS_NewCFunctionMagic (ctx, js_request_headers_add_or_upsert, "upsert", 2,
    JS_CFUNC_generic_magic, 1),
    HEADER_METHOD_FLAGS);
    JS_DefinePropertyValueStr (ctx, headers, "remove",
    JS_NewCFunction (ctx, js_request_headers_remove, "remove", 1), HEADER_METHOD_FLAGS);
}

namespace {

// pm.response.reason() - the status line's reason phrase. Postman returns null
// when there is none; vayu always has one, because status 0 (its synthetic
// value for a client-side failure) is in the canonical table as "Error".
JSValue js_response_reason (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = get_context_data (ctx);
    if (!data || !data->response) {
        return JS_ThrowInternalError (ctx, "No response available");
    }
    return JS_NewString (ctx, response_reason_phrase (*data->response).c_str ());
}

// pm.response.size() -> { body, header, total }, in bytes.
//
// `body` is the body the script can actually read through text(), so
// size().body and text().length agree for an ASCII body. `header` is
// reconstructed, see `response_size_bytes`.
JSValue js_response_size (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    const Response* response = require_response (ctx);
    if (!response) {
        return JS_EXCEPTION;
    }
    const ResponseSizeBytes bytes = response_size_bytes (*response);

    JSValue size = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, size, "body", JS_NewInt64 (ctx, static_cast<int64_t> (bytes.body)));
    JS_SetPropertyStr (
    ctx, size, "header", JS_NewInt64 (ctx, static_cast<int64_t> (bytes.header)));
    JS_SetPropertyStr (ctx, size, "total",
    JS_NewInt64 (ctx, static_cast<int64_t> (bytes.body + bytes.header)));
    return size;
}

/**
 * Bind the streamed response's event list and its two markers onto
 * `pm.response`, or bind nothing at all (issue #575).
 *
 * Three properties, one arrival set: `events` is the bounded stored list,
 * `totalEvents` is how many the stream actually received, and
 * `eventsTruncated` says whether the two differ. A script that asserts over a
 * prefix believing it has the whole stream is the failure this exists to make
 * impossible, so the markers are never optional decoration - they are bound
 * with the list or the list is not bound.
 *
 * Absent, not empty, for a non-stream response: `typeof pm.response.events`
 * separates "not a stream" from "a stream with no events", which an empty
 * array could not. Same rule as `pm.request.body` and `pm.iterationData`.
 *
 * Entries are `{ event, id?, data, dataTruncated? }`. The stored node spells
 * the upstream id `sourceId` because a relay frame id sits beside it there;
 * inside a script there is only one id to mean, so it is `id`. `id` is absent
 * when the origin sent none, rather than `""` - a script comparing ids must be
 * able to see that there was nothing to compare.
 */
void install_response_events (JSContext* ctx, JSValue response, const nlohmann::json* node) {
    if (!node || !node->is_object ()) {
        return;
    }

    JSValue events       = JS_NewArray (ctx);
    uint32_t index       = 0;
    const auto items     = node->find ("items");
    const bool has_items = items != node->end () && items->is_array ();
    if (has_items) {
        for (const auto& item : *items) {
            if (!item.is_object ()) {
                continue;
            }
            JSValue entry = JS_NewObject (ctx);
            const std::string name = item.value ("event", std::string ("message"));
            JS_SetPropertyStr (ctx, entry, "event",
            JS_NewStringLen (ctx, name.data (), name.size ()));
            const std::string data = item.value ("data", std::string ());
            JS_SetPropertyStr (ctx, entry, "data",
            JS_NewStringLen (ctx, data.data (), data.size ()));
            if (const auto source_id = item.find ("sourceId");
            source_id != item.end () && source_id->is_string ()) {
                const auto id = source_id->get<std::string> ();
                JS_SetPropertyStr (
                ctx, entry, "id", JS_NewStringLen (ctx, id.data (), id.size ()));
            }
            // Per-event truncation is disclosed in band exactly as the stored
            // node discloses it: an event whose data is a prefix must never
            // read as a whole one.
            if (item.value ("dataTruncated", false)) {
                JS_SetPropertyStr (ctx, entry, "dataTruncated", JS_NewBool (ctx, 1));
            }
            JS_SetPropertyUint32 (ctx, events, index++, entry);
        }
    }

    JS_SetPropertyStr (ctx, response, "events", events);
    JS_SetPropertyStr (ctx, response, "totalEvents",
    JS_NewInt64 (ctx, node->value ("totalEvents", static_cast<int64_t> (index))));
    JS_SetPropertyStr (ctx, response, "eventsTruncated",
    JS_NewBool (ctx, node->value ("eventsTruncated", false) ? 1 : 0));
}

// One hop's received headers in the shape `pm.response.headers` has: lower-cased
// names, a repeated name folded with ", ", get()/has() and no mutators. The fold
// is what `ingest_header_line` does to the final response, so a hop and the
// response read the same way; a hop's `Set-Cookie` lines therefore join like the
// response's do.
JSValue hop_headers_object (JSContext* ctx, const std::vector<HeaderLine>& lines) {
    Headers folded;
    for (const auto& line : lines) {
        auto [it, inserted] =
        folded.try_emplace (vayu::utils::ascii_lower (line.name), line.value);
        if (!inserted) {
            it->second += ", " + line.value;
        }
    }
    JSValue headers = JS_NewObject (ctx);
    install_header_methods (ctx, headers, /*mutators=*/false);
    for (const auto& [key, value] : folded) {
        define_header_entry (ctx, headers, key, value);
    }
    return headers;
}

/**
 * Bind `pm.response.redirects`, the 3xx responses followed on the way to this
 * one, or bind nothing when the producer did not record them (issue #2949).
 *
 * Each entry is `{ code, status, url, schemeDowngrade, headers }`, named as
 * `pm.response` names the same facts: `code` is the number and `status` the
 * reason phrase. `url` is the request that hop answered, with an
 * auth-query parameter's value blanked, and `schemeDowngrade` marks a Location
 * that left `https` for `http`. An empty array is a recorded "nothing was
 * redirected"; absence is "not recorded" - see `ScriptContext::redirect_hops`.
 */
void install_response_redirects (JSContext* ctx,
JSValue response,
const std::vector<RedirectHop>* hops) {
    if (!hops) {
        return;
    }
    JSValue redirects = JS_NewArray (ctx);
    uint32_t index    = 0;
    for (const auto& hop : *hops) {
        JSValue entry = JS_NewObject (ctx);
        JS_SetPropertyStr (ctx, entry, "code", JS_NewInt32 (ctx, hop.status_code));
        JS_SetPropertyStr (ctx, entry, "status",
        JS_NewStringLen (ctx, hop.status_text.data (), hop.status_text.size ()));
        JS_SetPropertyStr (ctx, entry, "url",
        JS_NewStringLen (ctx, hop.url.data (), hop.url.size ()));
        JS_SetPropertyStr (ctx, entry, "schemeDowngrade",
        JS_NewBool (ctx, hop.scheme_downgrade ? 1 : 0));
        JS_SetPropertyStr (ctx, entry, "headers", hop_headers_object (ctx, hop.header_lines));
        JS_SetPropertyUint32 (ctx, redirects, index++, entry);
    }
    JS_SetPropertyStr (ctx, response, "redirects", redirects);
}

} // namespace

void setup_pm_response (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    // Free old response object if it exists to prevent memory leak
    JSValue old_response = JS_GetPropertyStr (ctx, pm, "response");
    if (!JS_IsUndefined (old_response)) {
        JS_FreeValue (ctx, old_response);
    }

    JSValue response = JS_NewObject (ctx);

    if (data && data->response) {
        // pm.response.code
        JS_SetPropertyStr (
        ctx, response, "code", JS_NewInt32 (ctx, data->response->status_code));

        // pm.response.status - Postman's reason phrase, not a second spelling
        // of the code. Derived here rather than carried: the phrase is wanted
        // only when a script reads it, and scripts run deferred on sampled
        // responses, so nothing is added to the transfer path for it.
        JS_SetPropertyStr (ctx, response, "status",
        JS_NewString (ctx, response_reason_phrase (*data->response).c_str ()));

        // pm.response.responseTime - perceived latency (submit → completion),
        // includes generator-side queue wait. For pure server time, use
        // responseTimeWire. queue_wait_ms is exposed as responseTimeQueueWait.
        JS_SetPropertyStr (ctx, response, "responseTime",
        JS_NewFloat64 (ctx, data->response->timing.total_ms));
        JS_SetPropertyStr (ctx, response, "responseTimeWire",
        JS_NewFloat64 (ctx, data->response->timing.wire_ms));
        JS_SetPropertyStr (ctx, response, "responseTimeQueueWait",
        JS_NewFloat64 (ctx, data->response->timing.queue_wait_ms));

        // Error information (for client-side failures)
        if (data->response->error_code != vayu::ErrorCode::None) {
            JS_SetPropertyStr (ctx, response, "errorCode",
            JS_NewString (ctx, vayu::to_string (data->response->error_code)));
            JS_SetPropertyStr (ctx, response, "errorMessage",
            JS_NewString (ctx, data->response->error_message.c_str ()));
        }

        // pm.response.json() and pm.response.text()
        install_response_body_readers (ctx, response, data->response->body);

        // pm.response.reason()
        JS_SetPropertyStr (ctx, response, "reason",
        JS_NewCFunction (ctx, js_response_reason, "reason", 0));

        // pm.response.size()
        JS_SetPropertyStr (ctx, response, "size",
        JS_NewCFunction (ctx, js_response_size, "size", 0));

        // pm.response.responseSize - `size().body`, under the name Postman
        // scripts read it by.
        JS_SetPropertyStr (ctx, response, "responseSize",
        JS_NewInt64 (ctx, static_cast<int64_t> (data->response->body.size ())));

        // pm.response.headers - a plain object with get()/has() over it. No
        // mutators: the response has already arrived, so a header method that
        // appeared to change it would be a lie.
        JSValue headers = JS_NewObject (ctx);
        install_header_methods (ctx, headers, /*mutators=*/false);
        for (const auto& [key, value] : data->response->headers) {
            define_header_entry (ctx, headers, key, value);
        }
        JS_SetPropertyStr (ctx, response, "headers", headers);

        // pm.response.cookies - a getter, so a script that never mentions
        // cookies never pays for the parse. Configurable because the getter
        // replaces itself with the list it built.
        JSAtom cookies_atom = JS_NewAtom (ctx, "cookies");
        // Enumerable like every other member of pm.response, so
        // console.log(pm.response) and JSON.stringify show it rather than
        // hiding a documented property behind its own laziness.
        JS_DefinePropertyGetSet (ctx, response, cookies_atom,
        JS_NewCFunction (ctx, js_response_cookies, "cookies", 0), JS_UNDEFINED,
        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
        JS_FreeAtom (ctx, cookies_atom);

        // pm.response.events / totalEvents / eventsTruncated - a streamed run
        // only. Bound together or not at all: a script that reads the list
        // without its markers cannot tell a whole stream from its prefix, and
        // the three are one fact about one arrival set.
        install_response_events (ctx, response, data->response_events);

        // pm.response.redirects - the followed 3xx hops, where recorded.
        install_response_redirects (ctx, response, data->redirect_hops);

        // pm.response.to.have chain for Postman-compatible assertions
        JS_SetPropertyStr (
        ctx, response, "to", create_response_to_object (ctx, POSITIVE_CHAIN));
    }

    JS_SetPropertyStr (ctx, pm, "response", response);
}

} // namespace vayu::runtime::pm_detail
