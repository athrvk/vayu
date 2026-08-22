#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/js_json.hpp
 * @brief The JavaScript the renderer's import parsers were written in, once
 *        (issues #865, #877).
 *
 * Internal to `src/core`, and a header for the same reason `openapi_walk.hpp`
 * is one: two readers of a foreign document must not disagree about what its
 * bytes mean. These are not utilities - each is a JavaScript semantic the
 * parsers rest on and C++ does not share. `??` falls through `null` but not
 * `false`; `String(x)` on a number prints the shortest round-tripping form and
 * never a trailing `.0`; `if (content[ct])` is truthiness, so an empty object
 * passes and an empty string does not; `encodeURIComponent` leaves `!*\'()`
 * alone where a percent-encoder written for a URL does not.
 *
 * They lived inside `openapi_drafts.cpp` while the drafts were their only
 * reader (#865). The import moved engine-side in #877 and reads Postman and
 * Insomnia documents by the same rules - a variable-carrying row is not
 * percent-encoded in either format, and both write their numbers the way
 * `JSON.stringify` does - so a second copy here is the repo\'s
 * hand-rolled-copy defect waiting to drift.
 */

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::core::js {

using json = nlohmann::ordered_json;

// ---------------------------------------------------------------------------
// The JavaScript the renderer's parsers are written in
// ---------------------------------------------------------------------------

/// `prop(node, key)`: the property, or `nullptr` for "undefined" - a missing
/// key, or a node that is not an object at all.
inline const json* prop (const json* node, std::string_view key) {
    if (node == nullptr || !node->is_object ()) {
        return nullptr;
    }
    const auto found = node->find (key);
    return found == node->end () ? nullptr : &(*found);
}

/// `asRecord(v)`: the node when it is a JSON object, else `nullptr`.
inline const json* as_record (const json* node) {
    return node != nullptr && node->is_object () ? node : nullptr;
}

/// `asStr(v)`: the node's text when it is a string, else "undefined". Never
/// coerces - an unquoted `name: 5` is not a name here, exactly as it is not one
/// on the renderer side.
inline const std::string* as_str (const json* node) {
    return node != nullptr && node->is_string () ?
    node->get_ptr<const std::string*> () :
    nullptr;
}

/// `asArray(v)[index]`: the entry, or `nullptr` for a non-array or a short one.
inline const json* array_at (const json* node, size_t index) {
    if (node == nullptr || !node->is_array () || index >= node->size ()) {
        return nullptr;
    }
    return &(*node)[index];
}

/// JavaScript truthiness: everything except `undefined`, `null`, `false`, `0`
/// and `""`. An empty object and an empty array are both truthy, which is what
/// `if (content[ct])` and `if (schema.items)` rest on.
inline bool truthy (const json* node) {
    if (node == nullptr || node->is_null ()) {
        return false;
    }
    if (node->is_boolean ()) {
        return node->get<bool> ();
    }
    if (node->is_number ()) {
        return node->get<double> () != 0.0;
    }
    if (node->is_string ()) {
        return !node->get_ref<const std::string&> ().empty ();
    }
    return true;
}

/**
 * `String(number)` / a number as `JSON.stringify` writes it.
 *
 * The renderer's drafts carry numbers as text - a parameter's declared value in
 * a row, a sampled body's fields in a JSON string - and both sides have to
 * spell them identically or the diff sees a change. JavaScript prints the
 * *shortest* representation that round-trips and never a trailing `.0`, where
 * `nlohmann::dump` writes `1.0` for a whole float.
 *
 * Exact for every finite value below 1e21 in magnitude, which is every number a
 * document realistically declares; past that both sides switch to exponential
 * notation and JavaScript's exact threshold (an exponent of 21, or -7) is not
 * worth carrying for a value no OpenAPI example holds.
 */
inline std::string js_number_text (const json& value) {
    if (value.is_number_integer () || value.is_number_unsigned ()) {
        return value.dump ();
    }
    const double real = value.get<double> ();
    if (!std::isfinite (real)) {
        return "null"; // What `JSON.stringify` writes for NaN and Infinity.
    }
    if (std::trunc (real) == real && std::abs (real) < 1e21) {
        std::array<char, 64> buffer{};
        const int written = std::snprintf (buffer.data (), buffer.size (), "%.0f", real);
        if (written > 0) {
            std::string text (buffer.data (), static_cast<size_t> (written));
            // `%.0f` writes "-0" for negative zero; JavaScript writes "0".
            return text == "-0" ? "0" : text;
        }
    }
    std::array<char, 64> buffer{};
    const auto result =
    std::to_chars (buffer.data (), buffer.data () + buffer.size (), real);
    std::string text (buffer.data (), result.ptr);
    // `to_chars` writes `1e+21` / `1e-07`; JavaScript writes `1e+21` / `1e-7`.
    const size_t exponent = text.find ('e');
    if (exponent != std::string::npos) {
        size_t digits = exponent + 1;
        if (digits < text.size () && (text[digits] == '+' || text[digits] == '-')) {
            ++digits;
        }
        while (digits + 1 < text.size () && text[digits] == '0') {
            text.erase (digits, 1);
        }
    }
    return text;
}

/// `String(value)` for the scalars a `name` or an `in` can hold. A document
/// writing `name: 5` names the parameter "5" on both sides.
inline std::string js_string_of (const json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_number ()) {
        return js_number_text (value);
    }
    if (value.is_boolean ()) {
        return value.get<bool> () ? "true" : "false";
    }
    if (value.is_null ()) {
        return "null";
    }
    return value.is_array () ? value.dump () : "[object Object]";
}

/// One string as `JSON.stringify` quotes it: the six short escapes, `\uXXXX`
/// for the rest of the control range, and every other byte verbatim (both
/// sides emit UTF-8 rather than escaping it).
inline void append_json_string (const std::string& value, std::string& out) {
    out += '"';
    for (const char ch : value) {
        switch (ch) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char> (ch) < 0x20) {
                std::array<char, 8> escape{};
                std::snprintf (escape.data (), escape.size (), "\\u%04x",
                static_cast<unsigned int> (static_cast<unsigned char> (ch)));
                out += escape.data ();
            } else {
                out += ch;
            }
            break;
        }
    }
    out += '"';
}

inline void append_json_text (const json& value, size_t indent, size_t step, std::string& out);

inline void
append_json_container (const json& value, size_t indent, size_t step, std::string& out) {
    const bool array = value.is_array ();
    if (value.empty ()) {
        out += array ? "[]" : "{}";
        return;
    }
    // `JSON.stringify(value)` with no space argument writes no whitespace at
    // all - not even after a colon - which is what @p step of 0 is.
    const bool pretty = step > 0;
    out += array ? "[" : "{";
    const std::string inner (pretty ? indent + step : 0, ' ');
    bool first = true;
    for (auto entry = value.begin (); entry != value.end (); ++entry) {
        if (!first) {
            out += ',';
        }
        first = false;
        if (pretty) {
            out += '\n';
            out += inner;
        }
        if (!array) {
            append_json_string (entry.key (), out);
            out += pretty ? ": " : ":";
        }
        append_json_text (entry.value (), indent + step, step, out);
    }
    if (pretty) {
        out += '\n';
        out.append (indent, ' ');
    }
    out += array ? ']' : '}';
}

inline void append_json_text (const json& value, size_t indent, size_t step, std::string& out) {
    if (value.is_null ()) {
        out += "null";
    } else if (value.is_boolean ()) {
        out += value.get<bool> () ? "true" : "false";
    } else if (value.is_number ()) {
        out += js_number_text (value);
    } else if (value.is_string ()) {
        append_json_string (value.get_ref<const std::string&> (), out);
    } else {
        append_json_container (value, indent, step, out);
    }
}

/// `JSON.stringify(value, null, 2)`, which is the text a draft's JSON body is.
inline std::string js_json_text (const json& value) {
    std::string out;
    append_json_text (value, 0, 2, out);
    return out;
}

/// `JSON.stringify(value)` - no whitespace anywhere. What `asString()` writes
/// for a variable whose value is an object, and what a GraphQL envelope is.
inline std::string js_json_compact (const json& value) {
    std::string out;
    append_json_text (value, 0, 0, out);
    return out;
}

/**
 * `encodeURIComponent(value)`.
 *
 * Deliberately not `utils::url_encode`, which is a different function rather
 * than an older copy of this one: it percent-encodes `!*'()`, which
 * `encodeURIComponent` leaves alone. The renderer writes an imported URL with
 * the latter, and a URL spelled two ways is a field the diff reports as changed
 * every time it is asked.
 */
inline std::string encode_uri_component (const std::string& value) {
    static constexpr std::string_view HEX        = "0123456789ABCDEF";
    static constexpr std::string_view UNRESERVED = "-_.!~*'()";
    std::string out;
    out.reserve (value.size ());
    for (const char ch : value) {
        const auto c = static_cast<unsigned char> (ch);
        if (std::isalnum (c) != 0 || UNRESERVED.find (ch) != std::string_view::npos) {
            out += ch;
        } else {
            out += '%';
            out += HEX[c >> 4U];
            out += HEX[c & 0x0FU];
        }
    }
    return out;
}

/// `containsVariableToken(text)`: a `{{name}}` anywhere in the string. Such a
/// value is left unencoded, so the variable syntax survives into the URL.
inline bool contains_variable_token (const std::string& text) {
    for (size_t at = text.find ("{{"); at != std::string::npos;
    at             = text.find ("{{", at + 1)) {
        const size_t close = text.find ("}}", at + 2);
        if (close == std::string::npos) {
            return false;
        }
        // `[^{}]+` between the braces: a `{` inside is not this token's close.
        const std::string_view inner (text.data () + at + 2, close - at - 2);
        if (!inner.empty () && inner.find_first_of ("{}") == std::string_view::npos) {
            return true;
        }
    }
    return false;
}
// ---------------------------------------------------------------------------
// The URL (`normalizeVars` + `appendParamsToUrl`)
// ---------------------------------------------------------------------------

/// `toQueryString(params)`: the enabled rows, percent-encoded unless they carry
/// a `{{var}}`, and a bare key for a row with no value.
template <typename Row>
std::string query_string (const std::vector<Row>& params) {
    std::string out;
    for (const Row& row : params) {
        if (!row.enabled || row.key.find_first_not_of (" \t\n\r\f\v") == std::string::npos) {
            continue;
        }
        if (!out.empty ()) {
            out += '&';
        }
        out += contains_variable_token (row.key) ? row.key :
                                                   encode_uri_component (row.key);
        if (!row.value.empty ()) {
            out += '=';
            out += contains_variable_token (row.value) ?
            row.value :
            encode_uri_component (row.value);
        }
    }
    return out;
}

/**
 * `appendParamsToUrl(url, params)`, which the import factory applies to every
 * draft it produced.
 *
 * The rows are appended rather than replacing the query, because `url` and
 * `params[]` are two independent statements by the source - and a request built
 * in the app carries its enabled query *inside* `url` (issue #590), which is
 * why a draft that skipped this step would differ from every stored request it
 * is compared against.
 */
template <typename Row>
std::string append_params (const std::string& url, const std::vector<Row>& params) {
    const std::string query = query_string (params);
    if (query.empty ()) {
        return url;
    }
    if (url.find ('?') == std::string::npos) {
        return url + "?" + query;
    }
    // A URL ending in `?` or `&` is already sitting on its separator.
    const char last = url.back ();
    return last == '?' || last == '&' ? url + query : url + "&" + query;
}


} // namespace vayu::core::js
