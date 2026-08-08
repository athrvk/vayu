/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/form_body.hpp"

#include <curl/curl.h>

namespace vayu::http {

namespace {

// libcurl's percent-encoder, with its allocation returned to it. The handle
// argument is unused by libcurl (and documented as ignored), so this stays a
// pure function - no easy handle has to exist to encode a body.
std::string percent_encode (const std::string& value) {
    char* escaped =
    curl_easy_escape (nullptr, value.c_str (), static_cast<int> (value.size ()));
    if (!escaped) {
        return {};
    }
    std::string out (escaped);
    curl_free (escaped);
    return out;
}

// The inverse, with the media type's `+` rule applied before unescaping so a
// `%2B` still decodes to a literal plus. libcurl's unescape returns the decoded
// length out-of-band because a decoded value may contain NUL bytes.
std::string percent_decode (std::string value) {
    for (char& c : value) {
        if (c == '+') {
            c = ' ';
        }
    }
    int decoded_length = 0;
    char* unescaped    = curl_easy_unescape (
    nullptr, value.c_str (), static_cast<int> (value.size ()), &decoded_length);
    if (!unescaped) {
        return {};
    }
    std::string out (unescaped, static_cast<size_t> (decoded_length));
    curl_free (unescaped);
    return out;
}

} // namespace

bool is_form_mode (BodyMode mode) {
    return mode == BodyMode::Form || mode == BodyMode::FormData;
}

std::vector<FormField> enabled_fields (const std::vector<FormField>& fields) {
    std::vector<FormField> out;
    out.reserve (fields.size ());
    for (const auto& field : fields) {
        if (field.enabled) {
            out.push_back (field);
        }
    }
    return out;
}

std::string encode_urlencoded (const std::vector<FormField>& fields) {
    std::string out;
    for (const auto& field : fields) {
        if (!field.enabled) {
            continue;
        }
        if (!out.empty ()) {
            out += '&';
        }
        out += percent_encode (field.key);
        out += '=';
        out += percent_encode (field.value);
    }
    return out;
}

std::vector<FormField> parse_urlencoded (const std::string& encoded) {
    std::vector<FormField> fields;
    size_t start = 0;
    while (start <= encoded.size ()) {
        const size_t amp     = encoded.find ('&', start);
        const size_t end     = amp == std::string::npos ? encoded.size () : amp;
        const std::string kv = encoded.substr (start, end - start);
        if (!kv.empty ()) {
            const size_t eq = kv.find ('=');
            FormField field;
            field.key =
            percent_decode (eq == std::string::npos ? kv : kv.substr (0, eq));
            field.value   = eq == std::string::npos ?
              std::string{} :
              percent_decode (kv.substr (eq + 1));
            field.enabled = true;
            fields.push_back (std::move (field));
        }
        if (amp == std::string::npos) {
            break;
        }
        start = amp + 1;
    }
    return fields;
}

bool has_wire_body (const Body& body) {
    if (body.mode == BodyMode::None) {
        return false;
    }
    if (is_form_mode (body.mode)) {
        for (const auto& field : body.fields) {
            if (field.enabled) {
                return true;
            }
        }
        return false;
    }
    return !body.content.empty ();
}

std::string implied_content_type (const Body& body) {
    if (body.mode == BodyMode::Form && has_wire_body (body)) {
        return "application/x-www-form-urlencoded";
    }
    return {};
}

bool content_type_is_engine_owned (const Body& body) {
    return body.mode == BodyMode::FormData && has_wire_body (body);
}

} // namespace vayu::http
